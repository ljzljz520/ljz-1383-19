import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto, { timingSafeEqual } from 'node:crypto';
import { db, id, now } from './db.js';
import { PORT, OWNER_TOKEN, SITE_ROOT, TEMPLATE_ID } from './config.js';
import { buildSnapshot, recheckSnapshot, TEMPLATE_VERSION } from './content.js';
import { enqueueRender } from './worker.js';
import { createShare, revokeShare, validateProxyToken, verifySigned, buildLinks, logAccess } from './shares.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
const STATIC_ALLOW = new Set(['/', '/index.html', '/resume.html', '/css/style.css', '/js/main.js', '/js/resume.js', '/contact.html', '/hobbies.html', '/portfolio.html', '/hobby-detail.html', '/work-detail.html', '/solar-detail.html', '/self_test.txt', '/favicon.ico']);

function json(res, code, obj, headers = {}) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, ...headers });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 2e6) reject(Object.assign(new Error('payload too large'), { status: 413 })); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function auth(req) {
  const h = req.headers.authorization || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(got), b = Buffer.from(OWNER_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function taskRow(t) {
  return { ...t, checks: t.checks ? JSON.parse(t.checks) : null, receipt: t.receipt ? JSON.parse(t.receipt) : null };
}
function versionRow(v) {
  return { id: v.id, resume_id: v.resume_id, version: v.version, job_title: v.job_title, company: v.company,
    contact: JSON.parse(v.contact), source_ids: JSON.parse(v.source_ids), status: v.status,
    template_id: v.template_id, template_version: v.template_version, created_at: v.created_at };
}

function latestDonePdf(versionId) {
  return db.prepare("SELECT * FROM render_tasks WHERE resume_version_id=? AND status='done' ORDER BY updated_at DESC LIMIT 1").get(versionId);
}

function createVersion(resumeId, payload, expectedVersion) {
  const r = db.prepare('SELECT * FROM resumes WHERE id=?').get(resumeId);
  if (!r) return { err: 404, code: 'RESUME_NOT_FOUND' };
  if (expectedVersion !== undefined && expectedVersion !== r.current_version) {
    return { conflict: { code: 'VERSION_CONFLICT', current_version: r.current_version, message: '岗位已被另一方更新，请刷新后基于最新版本再编辑（并行编辑不互相覆盖）' } };
  }
  const contact = { ...JSON.parse(r.contact || '{}'), ...(payload.contact || {}) };
  const sourceIds = payload.source_ids;
  const jobTitle = (payload.job_title ?? r.job_title);
  const company = (payload.company ?? r.company);
  const snapshot = buildSnapshot({ sourceIds, jobTitle, company, contact }); // 私密来源 -> 400
  const nextVersion = r.current_version + 1;
  const vid = id('ver');
  db.prepare(`INSERT INTO resume_versions(id,resume_id,version,job_title,company,contact,source_ids,snapshot,template_id,template_version,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?, 'draft', ?)`)
    .run(vid, resumeId, nextVersion, jobTitle, company, JSON.stringify(contact), JSON.stringify([...new Set(sourceIds)]),
      JSON.stringify(snapshot), TEMPLATE_ID, TEMPLATE_VERSION, now());
  db.prepare('UPDATE resumes SET job_title=?, company=?, contact=?, current_version=?, updated_at=? WHERE id=?')
    .run(jobTitle, company, JSON.stringify(contact), nextVersion, now(), resumeId);
  return { version: versionRow(db.prepare('SELECT * FROM resume_versions WHERE id=?').get(vid)) };
}

// ————— 分享预览页（受控代理，每次都经服务器校验） —————
function previewHTML(share) {
  const t = db.prepare("SELECT * FROM render_tasks WHERE resume_version_id=? AND status='done' ORDER BY updated_at DESC LIMIT 1").get(share.resume_version_id);
  const ver = db.prepare('SELECT * FROM resume_versions WHERE id=?').get(share.resume_version_id);
  const note = `<p style="color:#667;font-size:12px;margin-top:18px">本链接由服务器校验访问权限（到期/撤销即时生效）。下载到本地的 PDF 无法被远程收回。有效期至 ${share.expires_at}。</p>`;
  if (!t) return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h3>简历尚未生成完成</h3>${note}`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${ver.job_title} - 简历</title>
<style>body{margin:0;background:#eef1f5;font-family:sans-serif}iframe{border:0;width:100vw;height:100vh}</style></head>
<body><iframe src="/s/${share.token}/dl#toolbar=0"></iframe></body></html>`;
}

async function servePublic(req, res, url) {
  // 受控代理
  let m = url.pathname.match(/^\/s\/([A-Za-z0-9_-]+)(?:\/(dl))?$/);
  if (m) {
    const v = validateProxyToken(m[1], req.socket.remoteAddress);
    if (!v.ok) { res.writeHead(v.status, { 'content-type': 'text/plain;charset=utf-8', 'cache-control': 'no-store' }); return res.end(v.code === 'REVOKED' ? '该分享链接已被撤销（410 Gone）' : v.code === 'EXPIRED' ? '该分享链接已过期（410 Gone）' : '链接不存在（404）'); }
    // 受控代理每次回源：作品转私密也立即停止对外展示
    const ver0 = db.prepare('SELECT * FROM resume_versions WHERE id=?').get(v.share.resume_version_id);
    const priv = ver0 ? recheckSnapshot(JSON.parse(ver0.snapshot)) : [{ reason: 'deleted' }];
    if (priv.length) { logAccess(v.share.id, 'source-private', req.socket.remoteAddress, JSON.stringify(priv)); res.writeHead(410, { 'content-type': 'text/plain;charset=utf-8', 'cache-control': 'no-store' }); return res.end('该简历引用的作品已转私密，链接已停用（410 Gone）'); }
    if (!m[2]) { html(res, previewHTML(v.share)); return true; }
    const t = latestDonePdf(v.share.resume_version_id);
    if (!t) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end('PDF not ready'); }
    sendPdf(res, t, 'inline', 'no-store'); // 撤销后旧链接：已 no-store，浏览器不会用缓存放行
    return true;
  }
  // 离线签名短链
  if (url.pathname === '/signed/pdf') {
    const v = verifySigned({ v: url.searchParams.get('v'), exp: url.searchParams.get('exp'), sig: url.searchParams.get('sig') }, req.socket.remoteAddress);
    if (!v.ok) { res.writeHead(v.status, { 'content-type': 'text/plain;charset=utf-8', 'cache-control': 'no-store' }); return res.end(v.code); }
    const t = latestDonePdf(v.version.id);
    if (!t) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end('PDF not ready'); }
    const ttl = Math.max(0, Math.round((v.expiresAtMs - Date.now()) / 1000));
    sendPdf(res, t, 'attachment', `private, max-age=${Math.min(ttl, 900)}, must-revalidate`);
    return true;
  }
  // 机主一次性下载票（60 秒、用后即焚），让 <a> 能在无鉴权头下取件
  const tm = url.pathname.match(/^\/dl\/([A-Za-z0-9_-]+)$/);
  if (tm) {
    const tk = db.prepare('SELECT * FROM download_tickets WHERE ticket=?').get(tm[1]);
    if (!tk || tk.used || new Date(tk.expires_at).getTime() < Date.now()) {
      res.writeHead(410, { 'content-type': 'text/plain;charset=utf-8', 'cache-control': 'no-store' });
      return res.end('下载链接已失效或已使用（410 Gone）');
    }
    const t = latestDonePdf(tk.resume_version_id);
    db.prepare('UPDATE download_tickets SET used=1 WHERE ticket=?').run(tm[1]);
    if (!t) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end('PDF not ready'); }
    sendPdf(res, t, 'attachment', 'private, no-store');
    return true;
  }
  return false;
}

function sendPdf(res, task, disposition, cacheControl) {
  const buf = fs.readFileSync(task.pdf_path);
  res.writeHead(200, {
    'content-type': 'application/pdf',
    'content-length': buf.length,
    'content-disposition': `${disposition}; filename="resume.pdf"`,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  });
  res.end(buf);
}
function html(res, s) { const b = Buffer.from(s); res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' }); res.end(b); }

function serveStatic(req, res, url) {
  if (!STATIC_ALLOW.has(url.pathname)) return false;
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const fp = path.join(SITE_ROOT, p);
  if (!fp.startsWith(SITE_ROOT) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) return false;
  const buf = fs.readFileSync(fp);
  res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream', 'content-length': buf.length });
  res.end(buf);
  return true;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (await servePublic(req, res, url)) return;
      if (await serveStatic(req, res, url)) return;
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

      const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
      // 健康检查
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, template: `${TEMPLATE_ID}@${TEMPLATE_VERSION}`, time: now() });

      if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};

      // —— 来源（教育/技能/项目库） ——
      if (req.method === 'GET' && seg[1] === 'sources' && !seg[2]) {
        return json(res, 200, db.prepare('SELECT * FROM sources ORDER BY kind, id').all());
      }
      if (req.method === 'GET' && seg[1] === 'sources' && seg[2]) {
        const s = db.prepare('SELECT * FROM sources WHERE id=?').get(seg[2]);
        if (!s) return json(res, 404, { error: 'source not found' });
        return json(res, 200, s);
      }
      if (req.method === 'PATCH' && seg[1] === 'sources' && seg[2]) {
        const s = db.prepare('SELECT * FROM sources WHERE id=?').get(seg[2]);
        if (!s) return json(res, 404, { error: 'source not found' });
        const visible = body.visible === undefined ? s.visible : (body.visible ? 1 : 0);
        db.prepare('UPDATE sources SET visible=?, updated_at=? WHERE id=?').run(visible, now(), s.id);
        return json(res, 200, db.prepare('SELECT * FROM sources WHERE id=?').get(s.id));
      }

      // —— 岗位简历 ——
      if (req.method === 'GET' && seg[1] === 'resumes' && !seg[2]) {
        const rows = db.prepare('SELECT * FROM resumes ORDER BY updated_at DESC').all().map((r) => ({
          ...r, contact: JSON.parse(r.contact),
          versions: db.prepare('SELECT id,version,status,job_title,company,created_at FROM resume_versions WHERE resume_id=? ORDER BY version').all(r.id),
        }));
        return json(res, 200, rows);
      }
      if (req.method === 'POST' && seg[1] === 'resumes' && !seg[2]) {
        if (!body.job_title) return json(res, 400, { error: 'job_title required' });
        if (!body.source_ids?.length) return json(res, 400, { error: 'source_ids required' });
        let snap;
        try { snap = buildSnapshot({ sourceIds: body.source_ids, jobTitle: body.job_title, company: body.company, contact: body.contact }); } catch (e) { return json(res, 400, { code: e.code, error: e.message, sources: e.sources }); }
        const rid = id('rsm');
        const vid = id('ver');
        const v1now = now();
        db.prepare(`INSERT INTO resumes
            (id, job_title, company, contact, current_version, created_at, updated_at)
          VALUES (@id, @job_title, @company, @contact, 1, @ts, @ts)`)
          .run({ id: rid, job_title: body.job_title, company: body.company || '', contact: JSON.stringify(snap.contact), ts: v1now });
        db.prepare(`INSERT INTO resume_versions
            (id, resume_id, version, job_title, company, contact, source_ids, snapshot, template_id, template_version, status, created_at)
          VALUES (@id, @rid, 1, @job_title, @company, @contact, @source_ids, @snapshot, @tpl, @tplv, 'draft', @ts)`)
          .run({ id: vid, rid, job_title: body.job_title, company: body.company || '', contact: JSON.stringify(snap.contact),
                 source_ids: JSON.stringify(body.source_ids), snapshot: JSON.stringify(snap),
                 tpl: TEMPLATE_ID, tplv: TEMPLATE_VERSION, ts: v1now });
        return json(res, 201, { resume_id: rid, version: versionRow(db.prepare('SELECT * FROM resume_versions WHERE id=?').get(vid)) });
      }
      if (req.method === 'GET' && seg[1] === 'resumes' && seg[2]) {
        const r = db.prepare('SELECT * FROM resumes WHERE id=?').get(seg[2]);
        if (!r) return json(res, 404, { error: 'not found' });
        return json(res, 200, { ...r, contact: JSON.parse(r.contact), versions: db.prepare('SELECT * FROM resume_versions WHERE resume_id=? ORDER BY version').all(r.id).map(versionRow) });
      }
      if (req.method === 'POST' && seg[1] === 'resumes' && seg[3] === 'versions') {
        const out = createVersion(seg[2], body, body.expected_version);
        if (out.err) return json(res, out.err, { code: out.code, error: 'not found' });
        if (out.conflict) return json(res, 409, out.conflict);
        return json(res, 201, out.version);
      }

      // —— 版本 / 渲染 ——
      if (req.method === 'GET' && seg[1] === 'versions' && seg[3] === 'tasks') {
        const rows = db.prepare('SELECT * FROM render_tasks WHERE resume_version_id=? ORDER BY created_at DESC LIMIT 10').all(seg[2]);
        return json(res, 200, rows.map(taskRow));
      }
      if (req.method === 'GET' && seg[1] === 'versions' && seg[2] && !seg[3]) {
        const v = db.prepare('SELECT * FROM resume_versions WHERE id=?').get(seg[2]);
        if (!v) return json(res, 404, { error: 'not found' });
        return json(res, 200, { ...versionRow(v), snapshot: JSON.parse(v.snapshot) });
      }
      if (req.method === 'POST' && seg[1] === 'versions' && seg[3] === 'render') {
        const v = db.prepare('SELECT * FROM resume_versions WHERE id=?').get(seg[2]);
        if (!v) return json(res, 404, { error: 'version not found' });
        const key = body.idempotency_key || null;
        if (key) { const old = db.prepare('SELECT * FROM render_tasks WHERE idempotency_key=?').get(key); if (old) return json(res, 200, taskRow(old)); }
        const t = enqueueRender({
          resumeId: v.resume_id, resumeVersionId: v.id, idempotencyKey: key,
          strategy: body.strategy === 'manual' ? 'manual' : 'auto', level: Number(body.level ?? 0),
        });
        // 验收钩子：注入坏字体地址 / 渲染前延迟（模拟排队中转私密）
        if (body._test && (body._test.font_url || body._test.delay_ms)) {
          const specs = body._test.font_url ? JSON.stringify([
            { kind: 'url', weight: 400, url: body._test.font_url },
            { kind: 'url', weight: 700, url: body._test.font_url },
          ]) : null;
          db.prepare('INSERT OR REPLACE INTO test_render_opts(task_id,font_specs,delay_ms) VALUES(?,?,?)').run(t.id, specs, body._test.delay_ms || 0);
        }
        return json(res, 202, taskRow(db.prepare('SELECT * FROM render_tasks WHERE id=?').get(t.id)));
      }
      // 机主下载：先换一次性票据（60s、用后即焚），再走公开的 /dl/:ticket
      if (req.method === 'POST' && seg[1] === 'versions' && seg[3] === 'download-ticket') {
        if (!latestDonePdf(seg[2])) return json(res, 404, { code: 'NO_PDF', error: '该版本暂无已生成 PDF' });
        const ticket = crypto.randomBytes(18).toString('base64url');
        const exp = new Date(Date.now() + 60000).toISOString();
        db.prepare('INSERT INTO download_tickets(ticket,resume_version_id,used,expires_at) VALUES(?,?,0,?)').run(ticket, seg[2], exp);
        const origin = req.headers.origin || `http://${req.headers.host}`;
        return json(res, 200, { url: `${origin}/dl/${ticket}`, expires_at: exp, note: '已下载到本地的 PDF 无法远程收回' });
      }
      if (req.method === 'GET' && seg[1] === 'tasks' && seg[2] && seg[2] !== 'by-key') {
        const t = db.prepare('SELECT * FROM render_tasks WHERE id=?').get(seg[2]);
        if (!t) return json(res, 404, { error: 'task not found' });
        return json(res, 200, taskRow(t));
      }
      if (req.method === 'GET' && seg[1] === 'tasks' && seg[2] === 'by-key' && seg[3]) {
        const t = db.prepare('SELECT * FROM render_tasks WHERE idempotency_key=?').get(seg[3]);
        if (!t) return json(res, 404, { error: 'no task for key', hint: '导出回执丢失：用相同 idempotency_key 重新 POST /render 也可幂等取回' });
        return json(res, 200, taskRow(t));
      }

      // —— 分享 ——
      if (req.method === 'POST' && seg[1] === 'versions' && seg[3] === 'share') {
        const v = db.prepare('SELECT * FROM resume_versions WHERE id=?').get(seg[2]);
        if (!v) return json(res, 404, { error: 'version not found' });
        if (!latestDonePdf(v.id)) return json(res, 409, { code: 'NO_PDF', error: '该版本还没有成功生成的 PDF，不能分享' });
        const mode = body.mode === 'signed' ? 'signed' : 'proxy';
        const defaultTtl = mode === 'signed' ? 900 : 7 * 86400;
        const ttl = Math.min(Math.max(Number(body.ttl_seconds) || defaultTtl, 60), mode === 'signed' ? 86400 : 30 * 86400);
        const share = createShare({ resumeId: v.resume_id, resumeVersionId: v.id, mode, ttlSeconds: ttl });
        db.prepare("UPDATE resume_versions SET status='shared' WHERE id=? AND status!='shared'").run(v.id);
        const origin = req.headers.origin || `http://${req.headers.host}`;
        return json(res, 201, { share: { token: share.token, mode, revoked: !!share.revoked, expires_at: share.expires_at }, links: buildLinks(share, origin) });
      }
      if (req.method === 'GET' && seg[1] === 'shares' && !seg[2]) {
        const rows = db.prepare('SELECT s.*, (SELECT COUNT(*) FROM share_access a WHERE a.share_id=s.id AND a.result=\'ok\') AS ok_hits FROM shares s ORDER BY s.created_at DESC').all();
        return json(res, 200, rows);
      }
      if (req.method === 'POST' && seg[1] === 'shares' && seg[3] === 'revoke') {
        const s = revokeShare(seg[2]);
        if (!s) return json(res, 404, { error: 'share not found' });
        return json(res, 200, { token: s.token, revoked: true, note: '受控代理链接立即失效（no-store）；离线签名链接在有效期内本就不可即时撤销，请改用 proxy 模式' });
      }
      if (req.method === 'GET' && seg[1] === 'shares' && seg[3] === 'access') {
        const s = db.prepare('SELECT * FROM shares WHERE token=?').get(seg[2]);
        if (!s) return json(res, 404, { error: 'not found' });
        return json(res, 200, db.prepare('SELECT ts,result,ip,detail FROM share_access WHERE share_id=? ORDER BY ts DESC LIMIT 100').all(s.id));
      }
      return json(res, 404, { error: 'unknown api route' });
    } catch (e) {
      if (res.headersSent) { console.error('error after headers sent:', req.method, req.url, e); try { res.end(); } catch {} return; }
      return json(res, e.status || 500, { code: e.code || 'ERROR', error: String(e.message || e), ...(e.sources ? { sources: e.sources } : {}) });
    }
  });
}

export function start() {
  const srv = createServer();
  return new Promise((resolve) => srv.listen(PORT, () => { console.log(`resume workflow on http://localhost:${PORT} (owner token: ${OWNER_TOKEN})`); resolve(srv); }));
}
