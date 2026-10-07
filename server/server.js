// 个人站 · 岗位简历工作流服务
// 职责：字段选择 -> 内容/模板冻结 -> 渲染任务 -> 真实 PDF -> 一页渲染后校验 -> 受控分享
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const { load, mutate, DATA_DIR } = require('./db');
const { makeDownloadToken, verifyDownloadToken, newId } = require('./crypto-util');
const { generatePdf } = require('./render/pdf');

const PORT = Number(process.env.PORT || 3000);
const HOST = '127.0.0.1';
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const ROOT = path.join(__dirname, '..');
const FONT_DIR = path.join(ROOT, 'node_modules', '@fontsource', 'noto-sans-sc');

const SIGNED_TTL_DEFAULT = 300; // 独立签名链接默认 5 分钟（短有效期）
const SIGNED_TTL_MAX = 600;
const PROXY_TTL_DEFAULT = 7 * 24 * 3600;

// ---------------- 工具 ----------------
const send = (res, code, obj, headers = {}) => {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(buf);
};
const readBody = req => new Promise((resolve, reject) => {
  let chunks = '';
  req.on('data', d => { chunks += d; if (chunks.length > 2e6) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(chunks ? JSON.parse(chunks) : {}); } catch { reject(new Error('bad json')); } });
});
const timingEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};
function requireAdmin(req) {
  return timingEqual(req.headers['x-admin-key'] || '', ADMIN_KEY);
}
function logEvent(ev) {
  return mutate(db => {
    db.events.unshift({ at: new Date().toISOString(), ...ev });
    if (db.events.length > 500) db.events.length = 500;
  });
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------- 冻结内容（固定来源快照） ----------------
function buildFrozenContent(db, position) {
  const s = db.sources;
  const projects = position.projectIds
    .map(id => s.projects.find(p => p.id === id))
    .filter(p => p && p.visibility === 'public') // 仅冻结当前仍公开的源；冻结后源再变私密不影响本快照
    .map(p => {
      const keep = position.bulletKeep && position.bulletKeep[p.id];
      const bullets = keep ? p.bullets.slice(0, keep) : p.bullets.slice();
      return { sourceId: p.id, title: p.title, role: p.role, period: p.period, bullets };
    });
  return {
    frozenAt: new Date().toISOString(),
    sourceContactSnapshot: JSON.parse(JSON.stringify(s.contact)),
    contact: JSON.parse(JSON.stringify(s.contact)),
    target: position.target,
    educations: position.eduIds.map(id => s.educations.find(e => e.id === id)).filter(Boolean).map(e => ({ ...e })),
    skills: position.skillIds.map(id => s.skills.find(k => k.id === id)).filter(Boolean).map(k => ({ ...k })),
    projects,
  };
}

// ---------------- 渲染队列 ----------------
let queueChain = Promise.resolve();
function enqueueRender(task) {
  queueChain = queueChain.then(() => task()).catch(err => {
      console.error('render task crashed', err);
  });
}

async function runRender(docId, { mode = 'auto', simulateFontFail = false }) {
  const baseUrl = `http://${HOST}:${PORT}`;
  const attempts = [];
  const levels = mode === 'auto' ? [1, 2, 3] : [3]; // manual：直接按最小版式渲染，让用户看到还超多少
  let last = null;

  for (const level of levels) {
    if (process.env.RENDER_DELAY_MS) await new Promise(r => setTimeout(r, Number(process.env.RENDER_DELAY_MS)));
    const doc = load().documents.find(d => d.id === docId);
    const { pdfBuf, metrics } = await generatePdf(doc, { level, baseUrl, simulateFontFail });
    attempts.push({ level, at: new Date().toISOString(), checks: metrics });
    last = { pdfBuf, metrics, level };

    // 字体失败或缺字属于硬失败：禁止自动降级成豆腐块 PDF
    const fontProblem = metrics.problems.find(p => p.type === 'missing-glyph');
    if (fontProblem) break;

    if (metrics.ok) break;
    if (!metrics.problems.some(p => p.type === 'overflow' || p.type === 'page-count')) break;
    // 仅当“仍然只是溢出/多页”时继续压缩
  }

  await mutate(db => {
    const doc = db.documents.find(d => d.id === docId);
    if (!doc) return;
    doc.render.attempts = attempts;
    const fontFail = last.metrics.problems.find(p => p.type === 'missing-glyph');
    const passed = last.metrics.ok;

    if (fontFail) {
      doc.status = 'failed';
      doc.render.error = 'FONT_UNAVAILABLE';
      doc.render.message = '字体下载失败或存在缺字，已阻止导出（不会产出含豆腐块的 PDF）。请重试或检查字体服务。';
    } else if (passed) {
      const file = path.join(DATA_DIR, 'artifacts', `${docId}_v${doc.positionRev}.pdf`);
      fs.writeFileSync(file, last.pdfBuf);
      doc.status = 'ready';
      doc.render.level = last.level;
      doc.render.checks = last.metrics;
      doc.render.pdfPath = file;
      doc.render.sha256 = sha256(last.pdfBuf);
      doc.render.size = last.pdfBuf.length;
      doc.readyAt = new Date().toISOString();
    } else {
      doc.status = 'failed';
      doc.render.level = last.level;
      doc.render.checks = last.metrics;
      if (mode === 'auto' && last.level === 3) {
        doc.render.error = 'NEED_MANUAL_TRIM';
        doc.render.message = '已自动压缩到最小版式（9pt）仍溢出一页。需手动删减：可去掉部分项目条目/技能组/教育经历后重试。';
      } else {
        doc.render.error = 'LAYOUT_FAILED';
        doc.render.message = '未通过一页渲染检查，请根据报告删减后重试。';
      }
    }
    // 快照落盘（固定来源证据）
    fs.writeFileSync(path.join(DATA_DIR, 'snapshots', `${docId}.json`), JSON.stringify(doc.content, null, 2));
  });
  await logEvent({ kind: 'render-finished', docId, mode, status: load().documents.find(d => d.id === docId)?.status });
}

// 启动时把渲染中卡住的任务标记失败（进程重启不丢任务记录）
function recoverStale() {
  mutate(db => {
    for (const d of db.documents) if (d.status === 'rendering') { d.status = 'failed'; d.render = d.render || {}; d.render.error = 'INTERRUPTED'; d.render.message = '服务重启导致渲染中断，请重新生成。'; }
  });
}

// ---------------- 字体端点 ----------------
function fontCss() {
  const weights = [400, 500, 700];
  // latin 子集覆盖 ASCII，chinese-simplified 子集覆盖 CJK；二者都必须就绪
  return weights.map(w => `
@font-face {
  font-family:'Noto Sans SC'; font-style:normal; font-weight:${w}; font-display:block;
  src:url('/__resume/files/noto-sans-sc-latin-${w}-normal.woff2') format('woff2'),
      url('/__resume/files/noto-sans-sc-latin-${w}-normal.woff') format('woff');
}
@font-face {
  font-family:'Noto Sans SC'; font-style:normal; font-weight:${w}; font-display:block;
  src:url('/__resume/files/noto-sans-sc-chinese-simplified-${w}-normal.woff2') format('woff2'),
      url('/__resume/files/noto-sans-sc-chinese-simplified-${w}-normal.woff') format('woff');
}`).join('\n');
}
const MIME = { '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  try {
    // ---------- 字体（渲染用） ----------
    if (p === '/__resume/fonts.css') {
      if (u.query.fail === '1') { res.writeHead(503); return res.end('font service simulated failure'); }
      res.writeHead(200, { 'content-type': MIME['.css'], 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(fontCss());
    }
    if (p.startsWith('/__resume/files/')) {
      const name = path.basename(p);
      const file = path.join(FONT_DIR, 'files', name);
      if (!file.startsWith(FONT_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': name.endsWith('woff2') ? MIME['.woff2'] : MIME['.woff'], 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' });
      return fs.createReadStream(file).pipe(res);
    }

    // ---------- 管理 API ----------
    if (p.startsWith('/api/')) {
      if (!requireAdmin(req)) return send(res, 401, { error: 'unauthorized' });

      // 固定来源
      if (p === '/api/sources' && req.method === 'GET') {
        const db = load();
        return send(res, 200, db.sources);
      }
      const srcProjM = p.match(/^\/api\/sources\/projects\/([\w-]+)\/visibility$/);
      if (srcProjM && req.method === 'POST') {
        const body = await readBody(req);
        return mutate(db => {
          const proj = db.sources.projects.find(x => x.id === srcProjM[1]);
          if (!proj) return send(res, 404, { error: 'project not found' });
          proj.visibility = body.visibility === 'private' ? 'private' : 'public';
          return send(res, 200, proj);
        });
      }

      // 岗位（草稿）
      if (p === '/api/positions' && req.method === 'GET') {
        return send(res, 200, load().positions);
      }
      if (p === '/api/positions' && req.method === 'POST') {
        const body = await readBody(req);
        const id = newId('pos');
        const position = {
          id, name: body.name || '未命名岗位', target: body.target || '',
          eduIds: body.eduIds || [], skillIds: body.skillIds || [], projectIds: body.projectIds || [],
          bulletKeep: body.bulletKeep || {},
          revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastDocId: null,
        };
        await mutate(db => db.positions.unshift(position));
        return send(res, 201, position);
      }
      const posM = p.match(/^\/api\/positions\/([\w_]+)$/);
      if (posM && req.method === 'GET') {
        const pos = load().positions.find(x => x.id === posM[1]);
        return pos ? send(res, 200, pos) : send(res, 404, { error: 'not found' });
      }
      if (posM && req.method === 'PATCH') {
        const body = await readBody(req);
        const matchRev = Number(req.headers['if-match'] || '');
        return mutate(db => {
          const pos = db.positions.find(x => x.id === posM[1]);
          if (!pos) return send(res, 404, { error: 'not found' });
          if (matchRev && matchRev !== pos.revision) {
            return send(res, 409, { error: 'revision-conflict', current: pos.revision, server: pos });
          }
          for (const k of ['name', 'target', 'eduIds', 'skillIds', 'projectIds', 'bulletKeep']) {
            if (body[k] !== undefined) pos[k] = body[k];
          }
          pos.revision += 1;
          pos.updatedAt = new Date().toISOString();
          return send(res, 200, pos);
        });
      }
      if (posM && req.method === 'DELETE') {
        await mutate(db => { db.positions = db.positions.filter(x => x.id !== posM[1]); });
        return send(res, 204, {});
      }

      // 冻结 + 渲染
      const freezeM = p.match(/^\/api\/positions\/([\w_]+)\/freeze$/);
      if (freezeM && req.method === 'POST') {
        const body = await readBody(req);
        const mode = body.mode === 'manual' ? 'manual' : 'auto';
        return mutate(db => {
          const pos = db.positions.find(x => x.id === freezeM[1]);
          if (!pos) return send(res, 404, { error: 'position not found' });
          const content = buildFrozenContent(db, pos);
          const doc = {
            id: newId('doc'), positionId: pos.id, positionName: pos.name,
            positionRev: pos.revision, content,
            status: 'rendering', createdAt: new Date().toISOString(),
            render: { mode, attempts: [] },
          };
          db.documents.unshift(doc);
          pos.lastDocId = doc.id;
          enqueueRender(() => runRender(doc.id, { mode, simulateFontFail: !!body.simulateFontFail }));
          return send(res, 202, { docId: doc.id, status: 'rendering' });
        });
      }

      if (p === '/api/documents' && req.method === 'GET') {
        return send(res, 200, load().documents.map(stripPdf));
      }
      const docM = p.match(/^\/api\/documents\/([\w_]+)$/);
      if (docM && req.method === 'GET') {
        const doc = load().documents.find(x => x.id === docM[1]);
        return doc ? send(res, 200, stripPdf(doc)) : send(res, 404, { error: 'not found' });
      }

      // 下载 PDF + 导出回执（回执先持久化，保证“回执丢失”可查、可重取）
      const pdfM = p.match(/^\/api\/documents\/([\w_]+)\/pdf$/);
      if (pdfM && req.method === 'GET') {
        const db = load();
        const doc = db.documents.find(x => x.id === pdfM[1]);
        if (!doc) return send(res, 404, { error: 'not found' });
        if (doc.status !== 'ready' || !doc.render.pdfPath || !fs.existsSync(doc.render.pdfPath)) {
          return send(res, 409, { error: 'artifact-not-ready', status: doc.status, hint: 'PDF 工件缺失或未生成，请重新生成。' });
        }
        const receipt = {
          id: newId('rcp'), docId: doc.id, at: new Date().toISOString(),
          via: 'admin', sha256: doc.render.sha256, size: doc.render.size,
          fileName: `简历-${doc.positionName}-v${doc.positionRev}.pdf`,
        };
        await mutate(d => (d.receipts = d.receipts || []).unshift(receipt));
        await logEvent({ kind: 'export', docId: doc.id, receiptId: receipt.id, via: 'admin' });
        res.writeHead(200, {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(receipt.fileName)}`,
          'x-receipt-id': receipt.id,
          'cache-control': 'no-store',
        });
        return fs.createReadStream(doc.render.pdfPath).pipe(res);
      }
      const rcpM = p.match(/^\/api\/documents\/([\w_]+)\/receipts$/);
      if (rcpM && req.method === 'GET') {
        return send(res, 200, (load().receipts||[]).filter(r => r.docId === rcpM[1]));
      }

      // 分享
      if (p === '/api/shares' && req.method === 'GET') return send(res, 200, load().shares);
      if (p === '/api/shares' && req.method === 'POST') {
        const body = await readBody(req);
        const doc = load().documents.find(d => d.id === body.docId);
        if (!doc || doc.status !== 'ready') return send(res, 409, { error: 'document-not-ready' });
        const mode = body.mode === 'signed' ? 'signed' : 'proxy';
        const ttl = Math.min(Number(body.ttlSeconds) || (mode === 'signed' ? SIGNED_TTL_DEFAULT : PROXY_TTL_DEFAULT),
          mode === 'signed' ? SIGNED_TTL_MAX : 90 * 24 * 3600);
        const share = {
          id: newId('shr'), token: crypto.randomBytes(18).toString('hex'),
          docId: doc.id, mode, createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
          revoked: false, revokeReason: null, accesses: [],
        };
        await mutate(db => db.shares.unshift(share));
        await logEvent({ kind: 'share-created', shareId: share.id, mode, docId: doc.id });
        return send(res, 201, shareView(share));
      }
      const shrM = p.match(/^\/api\/shares\/([\w_]+)$/);
      if (shrM && req.method === 'POST') {
        const body = await readBody(req);
        return mutate(db => {
          const shr = db.shares.find(x => x.id === shrM[1]);
          if (!shr) return send(res, 404, { error: 'not found' });
          if (!shr.revoked) {
            shr.revoked = true;
            shr.revokeReason = body.reason || 'user-revoked';
            shr.revokedAt = new Date().toISOString();
          }
          return send(res, 200, shareView(shr));
        }).then(() => logEvent({ kind: 'share-revoked', shareId: shrM[1] }));
      }

      if (p === '/api/events' && req.method === 'GET') return send(res, 200, load().events);
      return send(res, 404, { error: 'no such api', path: p });
    }

    // ---------- 公开访问：每次请求都查库验证到期与撤销 ----------
    const checkShare = token => {
      const shr = load().shares.find(s => s.token === token);
      if (!shr) return { deny: 404, reason: 'not-found' };
      if (shr.revoked) return { deny: 410, reason: 'revoked', shr };
      if (Date.now() > new Date(shr.expiresAt).getTime()) return { deny: 410, reason: 'expired', shr };
      const doc = load().documents.find(d => d.id === shr.docId);
      if (!doc || doc.status !== 'ready') return { deny: 410, reason: 'document-unavailable' };
      return { shr, doc };
    };

    const viewerM = p.match(/^\/s\/([\w-]+)$/);
    if (viewerM && req.method === 'GET') {
      const r = checkShare(viewerM[1]);
      res.writeHead(r.deny || 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      if (r.deny) return res.end(blockedPage(r.reason));
      return fs.createReadStream(path.join(ROOT, 'share-viewer.html')).pipe(res);
    }
    const metaM = p.match(/^\/p\/([\w-]+)\/meta$/);
    if (metaM && req.method === 'GET') {
      const r = checkShare(metaM[1]);
      if (r.deny) { await recordDeny(metaM[1], r.reason); return send(res, r.deny, { error: r.reason }); }
      const { shr, doc } = r;
      return send(res, 200, {
        mode: shr.mode, expiresAt: shr.expiresAt, positionName: doc.positionName,
        readyAt: doc.readyAt, rev: doc.positionRev,
        proxyPdfUrl: `/p/${shr.token}/pdf`,
        signedUrl: shr.mode === 'signed' ? signedLink(shr, doc) : null,
        cacheNote: shr.mode === 'proxy'
          ? '代理链接：每次访问均由服务器校验，撤销即时生效；响应 no-store。'
          : '签名直链：离线可验签，有效期内无法保证即时撤销，请依赖短有效期；下载后的 PDF 无法远程收回。',
      }, { 'cache-control': 'no-store' });
    }
    const proxyPdfM = p.match(/^\/p\/([\w-]+)\/pdf$/);
    if (proxyPdfM && req.method === 'GET') {
      const r = checkShare(proxyPdfM[1]);
      if (r.deny) { await recordDeny(proxyPdfM[1], r.reason); res.writeHead(r.deny, { 'cache-control': 'no-store' }); return res.end(r.reason); }
      if (r.shr.mode !== 'proxy') { res.writeHead(403, { 'cache-control': 'no-store' }); return res.end('signed-mode link does not allow proxy download'); }
      await mutate(db => { const s = db.shares.find(x => x.id === r.shr.id); s.accesses.push({ at: new Date().toISOString(), via: 'proxy' }); });
      res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store', 'content-disposition': 'inline' });
      return fs.createReadStream(r.doc.render.pdfPath).pipe(res);
    }

    // 独立签名直链：HMAC 离线可验签 + 在线仍查撤销（离线客户端无法被即时撤销，已在界面与文案中说明）
    const dlM = p.match(/^\/dl\/([\w.-]+)$/);
    if (dlM && req.method === 'GET') {
      const v = verifyDownloadToken(dlM[1]);
      if (!v.ok) { res.writeHead(v.reason === 'expired' ? 410 : 403, { 'cache-control': 'no-store' }); return res.end(v.reason); }
      const r = checkSignedShare(v.shareId, v.docId);
      if (r.deny) { res.writeHead(r.deny, { 'cache-control': 'no-store' }); return res.end(r.reason); }
      await mutate(db => { const s = db.shares.find(x => x.id === r.shr.id); s.accesses.push({ at: new Date().toISOString(), via: 'signed' }); });
      // 注意：这里允许边缘缓存到 expiresAt；离线持有副本者，撤销不保证生效
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'cache-control': `private, max-age=${Math.max(0, Math.floor((v.expiresAt - Date.now()) / 1000))}`,
        'x-signed-expiry': new Date(v.expiresAt).toISOString(),
      });
      return fs.createReadStream(r.doc.render.pdfPath).pipe(res);
    }

    // ---------- 静态站点 ----------
    return serveStatic(p, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'internal', message: err.message });
  }
});

function checkSignedShare(shareId, docId) {
  const shr = load().shares.find(s => s.id === shareId && s.docId === docId);
  if (!shr) return { deny: 404, reason: 'not-found' };
  if (shr.revoked) return { deny: 410, reason: 'revoked', shr };
  if (Date.now() > new Date(shr.expiresAt).getTime()) return { deny: 410, reason: 'expired', shr };
  const doc = load().documents.find(d => d.id === docId);
  if (!doc || doc.status !== 'ready') return { deny: 410, reason: 'document-unavailable' };
  return { shr, doc };
}

function signedLink(shr, doc) {
  const exp = new Date(shr.expiresAt).getTime();
  return `/dl/${makeDownloadToken(shr.id, doc.id, exp)}`;
}
function shareView(shr) {
  const doc = load().documents.find(d => d.id === shr.docId);
  const out = { ...shr };
  if (doc && shr.mode === 'signed') out.signedUrl = signedLink(shr, doc);
  return out;
}
async function recordDeny(token, reason) {
  await mutate(db => { const s = db.shares.find(x => x.token === token); if (s) s.accesses.push({ at: new Date().toISOString(), denied: reason }); });
  await logEvent({ kind: 'share-denied', reason, token: token.slice(0, 8) });
}
function blockedPage(reason) {
  const map = {
    revoked: ['链接已撤销', '该分享链接已被所有者撤销，无法继续访问。'],
    expired: ['链接已过期', '该分享链接已超过有效期，请联系对方重新发送。'],
    'not-found': ['链接不存在', '分享链接无效或已被删除。'],
    'document-unavailable': ['内容不可用', '对应的简历已不可访问。'],
  };
  const [t, d] = map[reason] || map['not-found'];
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="font-family:sans-serif;padding:60px;text-align:center"><h2>${t}</h2><p>${d}</p></body></html>`;
}

function stripPdf(doc) {
  const { render, ...rest } = doc;
  return { ...rest, render: { ...render, pdfPath: undefined } };
}

function serveStatic(p, res) {
  let rel = p === '/' ? '/index.html' : p;
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

recoverStale();
server.listen(PORT, () => console.log(`resume workflow on http://${HOST}:${PORT}`));
module.exports = { server, buildFrozenContent };
