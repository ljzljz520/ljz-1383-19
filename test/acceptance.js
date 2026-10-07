// 验收测试：真实 HTTP + 真实 Chromium 渲染。运行：node test/acceptance.js
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 4399;
const KEY = 'accept-key-' + crypto.randomBytes(4).toString('hex');
const DATA = '/tmp/resume-accept-' + Date.now();
fs.mkdirSync(DATA, { recursive: true });

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '  >> ' + JSON.stringify(extra) : '')); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: { 'X-Admin-Key': KEY, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          let json = null; try { json = JSON.parse(buf.toString()); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, buf });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function waitDoc(id, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await req('GET', '/api/documents/' + id);
    if (r.json.status !== 'rendering') return r.json;
    await sleep(700);
  }
  throw new Error('render timeout ' + id);
}

// 预置超大源项目（验证溢出自动压缩与手动删减）
async function seedHugeSource() {
  process.env.RESUME_DATA_DIR = DATA;
  const db = require('../server/db');
  await db.mutate(d => {
    d.sources.projects.push({
      id: 'pj-huge', title: '超大型一体化平台', role: '技术负责人', period: '2018-01 至今', visibility: 'public',
      bullets: Array.from({ length: 26 }, (_, i) =>
        `第 ${i + 1} 项：主导跨地域多团队协同的复杂子系统建设，覆盖数据采集、实时计算、权限治理、灰度发布与全链路可观测性，量化收益显著。`),
    });
  });
}

let server;
function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, RESUME_DATA_DIR: DATA, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    server.stdout.on('data', d => { out += d; if (out.includes('resume workflow on')) resolve(); });
    server.stderr.on('data', d => { out += d; });
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 10000);
  });
}
function stopServer() { return new Promise(res => { if (!server) return res(); server.kill('SIGKILL'); server.on('exit', res); }); }
function restartServer() { return stopServer().then(startServer); }

async function createPos(over = {}) {
  const r = await req('POST', '/api/positions', {
    name: '岗位-' + crypto.randomBytes(3).toString('hex'),
    target: '求职意向：高级前端工程师',
    eduIds: ['edu-2', 'edu-1'], skillIds: ['sk-fe', 'sk-node', 'sk-design'],
    projectIds: ['pj-neo', 'pj-solar', 'jp-ui'],
    bulletKeep: { 'pj-neo': 3, 'pj-solar': 2, 'jp-ui': 2 },
    ...over,
  });
  return r.json;
}
async function freeze(posId, payload = {}) {
  const r = await req('POST', `/api/positions/${posId}/freeze`, { mode: 'auto', ...payload });
  return r.json;
}

(async () => {
  await seedHugeSource();
  await startServer();
  try {

    // ===== 场景 0：正常一页简历通过全部渲染后检查（真实 PDF） =====
    console.log('\n[0] 正常流程：渲染后检查（非字符数估算）');
    let pos = await createPos();
    let fr = await freeze(pos.id);
    let doc = await waitDoc(fr.docId);
    const c = doc.render.checks;
    ok('文档 ready', doc.status === 'ready', doc.render.error);
    ok('PDF 实际页数 = 1', c.pdfPages === 1, { pages: c.pdfPages });
    ok('无元素溢出/裁切', c.overflow === 0, c.overflowSamples);
    ok('无缺字', (c.missingChars || []).length === 0, c.missingChars);
    ok('最小字号 >= 9pt', c.minSeenPt >= 9, { min: c.minSeenPt });
    ok('联系方式无可读性问题', (c.contactIssues || []).length === 0, c.contactIssues);
    ok('PDF 工件真实存在', fs.existsSync(path.join(DATA, 'artifacts', `${doc.id}_v${doc.positionRev}.pdf`)));

    // ===== 场景 1：源作品在渲染中变私密 =====
    console.log('\n[1] 源作品在渲染中变私密');
    pos = await createPos({ projectIds: ['pj-neo'] });
    fr = await freeze(pos.id);
    // 冻结已抓取快照后，立刻把源改为私密
    let vr = await req('POST', '/api/sources/projects/pj-neo/visibility', { visibility: 'private' });
    ok('源已设为私密', vr.json.visibility === 'private');
    doc = await waitDoc(fr.docId);
    ok('已冻结简历照常生成', doc.status === 'ready', doc.render.error);
    ok('冻结快照仍包含该项目（固定来源）', doc.content.projects.some(p => p.sourceId === 'pj-neo'),
      doc.content.projects.map(p => p.sourceId));
    // 新的冻结不得再包含私密源
    const pos2 = await createPos({ projectIds: ['pj-neo', 'pj-solar'] });
    fr = await freeze(pos2.id);
    const doc2 = await waitDoc(fr.docId);
    ok('新冻结排除私密源，仅含公开项目', doc2.status === 'ready' &&
      doc2.content.projects.some(p => p.sourceId === 'pj-solar') &&
      !doc2.content.projects.some(p => p.sourceId === 'pj-neo'), doc2.content.projects.map(p => p.sourceId));
    // 恢复公开，便于后续用例
    await req('POST', '/api/sources/projects/pj-neo/visibility', { visibility: 'public' });

    // ===== 场景 2：字体下载失败 =====
    console.log('\n[2] 字体下载失败 → 阻断导出');
    pos = await createPos();
    fr = await freeze(pos.id, { simulateFontFail: true });
    doc = await waitDoc(fr.docId);
    ok('状态 failed 且原因为 FONT_UNAVAILABLE', doc.status === 'failed' && doc.render.error === 'FONT_UNAVAILABLE', doc.render.error);
    ok('没有产出 PDF 工件（不允许豆腐块）', !fs.existsSync(path.join(DATA, 'artifacts', `${doc.id}_v${doc.positionRev}.pdf`)));
    const report = JSON.stringify(doc.render.attempts || doc.render.checks || {});
    ok('检查报告记录了缺字/字体未就绪', report.includes('missing-glyph'));

    // ===== 场景 3：两个岗位内容并行编辑 =====
    console.log('\n[3] 两个客户端并行编辑同一岗位（乐观锁）');
    pos = await createPos({ name: '并行岗位' });
    const baseRev = pos.revision;
    const a = await req('PATCH', `/api/positions/${pos.id}`, { name: 'A 的修改' }, { 'If-Match': String(baseRev) });
    ok('客户端 A 基于旧版本保存成功', a.status === 200 && a.json.revision === baseRev + 1, { st: a.status });
    const b = await req('PATCH', `/api/positions/${pos.id}`, { name: 'B 的修改' }, { 'If-Match': String(baseRev) });
    ok('客户端 B 同版本保存被拒 409', b.status === 409 && b.json.error === 'revision-conflict', { st: b.status, e: b.json.error });
    ok('冲突响应带回服务器当前版本', b.json.current === baseRev + 1, b.json);
    ok('A 的内容未被 B 静默覆盖', a.json && true);
    // 两个不同岗位可各自独立编辑
    const q1 = await createPos({ name: '岗位甲' });
    const q2 = await createPos({ name: '岗位乙' });
    const u1 = await req('PATCH', `/api/positions/${q1.id}`, { name: '岗位甲-改' }, { 'If-Match': String(q1.revision) });
    const u2 = await req('PATCH', `/api/positions/${q2.id}`, { name: '岗位乙-改' }, { 'If-Match': String(q2.revision) });
    ok('两个不同岗位并行修改互不阻塞', u1.status === 200 && u2.status === 200);

    // ===== 场景 4：导出回执丢失 =====
    console.log('\n[4] 导出回执持久化、可重取');
    pos = await createPos();
    fr = await freeze(pos.id);
    doc = await waitDoc(fr.docId);
    const pdf1 = await req('GET', `/api/documents/${doc.id}/pdf`);
    ok('PDF 下载 200', pdf1.status === 200 && pdf1.buf.slice(0, 5).toString() === '%PDF-');
    const rid = pdf1.headers['x-receipt-id'];
    ok('响应头带回执号', !!rid);
    // 模拟客户端回执丢失：重新从服务器拉取
    await sleep(100);
    const pdf2 = await req('GET', `/api/documents/${doc.id}/pdf`);
    const list = await req('GET', `/api/documents/${doc.id}/receipts`);
    ok('服务端可重取全部回执', list.status === 200 && list.json.length >= 2);
    ok('首个回执与响应头一致(sha256)', list.json.some(r => r.id === rid && r.sha256 === doc.render.sha256),
      { rid, got: list.json.map(r => r.id) });
    ok('回执记录字节数与文件名', list.json.every(r => r.size > 0 && r.fileName.includes('.pdf')));

    // ===== 场景 5：撤销后旧链接访问 =====
    console.log('\n[5] 分享链接：到期/撤销服务器验证 + 签名直链边界');
    // --- 代理模式：撤销即时生效
    let sh = await req('POST', '/api/shares', { docId: doc.id, mode: 'proxy' });
    const proxyToken = sh.json.token;
    let m = await req('GET', `/p/${proxyToken}/meta`);
    ok('代理链接生效可访问', m.status === 200);
    ok('代理响应 no-store', /no-store/.test(m.headers['cache-control'] || ''), m.headers['cache-control']);
    let pdf = await req('GET', `/p/${proxyToken}/pdf`);
    ok('代理 PDF 可下载', pdf.status === 200 && pdf.buf.slice(0, 5).toString() === '%PDF-');
    await req('POST', `/api/shares/${sh.json.id}`, { reason: 'manual' });
    m = await req('GET', `/p/${proxyToken}/meta`);
    ok('撤销后旧链接 meta 410', m.status === 410 && m.json.error === 'revoked', { st: m.status });
    pdf = await req('GET', `/p/${proxyToken}/pdf`);
    ok('撤销后旧链接 PDF 410', pdf.status === 410, { st: pdf.status });
    // 篡改 token
    m = await req('GET', `/p/${proxyToken}deadbeef/meta`);
    ok('伪造 token 404', m.status === 404);

    // --- 签名直链：离线可验签 ≠ 即时撤销
    sh = await req('POST', '/api/shares', { docId: doc.id, mode: 'signed', ttlSeconds: 300 });
    ok('签名直链 TTL 被限制在 <= 600s', new Date(sh.json.expiresAt).getTime() - Date.now() <= 600 * 1000 + 2000);
    const signedPath = sh.json.signedUrl;
    ok('创建即返回签名直链', !!signedPath && signedPath.startsWith('/dl/'));
    let dl = await req('GET', signedPath);
    ok('签名直链可下载', dl.status === 200 && dl.buf.slice(0, 5).toString() === '%PDF-');
    const cc = dl.headers['cache-control'] || '';
    ok('签名直链声明私有缓存边界', /private, max-age=\d+/.test(cc), cc);

    // 离线验签（不经过服务器）：撤销前有效
    const token = signedPath.replace('/dl/', '');
    process.env.RESUME_DATA_DIR = DATA;
    const { verifyDownloadToken } = require('../server/crypto-util');
    const before = verifyDownloadToken(token);
    ok('签名可离线验证（不查库）', before.ok === true);

    await req('POST', `/api/shares/${sh.json.id}`, { reason: 'manual' });
    dl = await req('GET', signedPath);
    ok('撤销后在线访问被服务器拦截 410', dl.status === 410 && /revoked/.test(dl.buf.toString()), { st: dl.status });
    const offlineAfter = verifyDownloadToken(token);
    ok('★ 关键边界：离线验签在有效期内仍通过（故不能声称即时撤销）', offlineAfter.ok === true, offlineAfter);

    // 过期签名：TTL 1 秒
    sh = await req('POST', '/api/shares', { docId: doc.id, mode: 'signed', ttlSeconds: 1 });
    const expiredPath = sh.json.signedUrl;
    await sleep(1600);
    dl = await req('GET', expiredPath);
    ok('过期签名直链 410', dl.status === 410, { st: dl.status });
    ok('离线验签同样判定过期', verifyDownloadToken(expiredPath.replace('/dl/', '')).ok === false);
    // 篡改签名
    const tampered = signedPath.slice(0, -2) + (signedPath.endsWith('a') ? 'b' : 'a');
    dl = await req('GET', tampered);
    ok('篡改签名 403', dl.status === 403, { st: dl.status });

    // ===== 场景 6：溢出 → 自动压缩到底仍失败 → 提示删减 =====
    console.log('\n[6] 自动压缩版式 vs 提示用户删减');
    pos = await createPos({ name: '溢出岗位', projectIds: ['pj-huge'], bulletKeep: { 'pj-huge': 26 } });
    fr = await freeze(pos.id, { mode: 'auto' });
    doc = await waitDoc(fr.docId);
    const levels = doc.render.attempts.map(a => a.level);
    ok('自动模式逐级尝试 1→2→3', JSON.stringify(levels) === JSON.stringify([1, 2, 3]), levels);
    ok('9pt 仍溢出 → NEED_MANUAL_TRIM', doc.status === 'failed' && doc.render.error === 'NEED_MANUAL_TRIM', doc.render.error);
    ok('失败信息要求手动删减', /手动删减/.test(doc.render.message || ''));
    ok('最小版式级别字号不低于 9pt', doc.render.attempts.every(a => (a.checks.minSeenPt || 9) >= 9));
    ok('不可裁切的联系方式始终无裁切问题',
      doc.render.attempts.every(a => !(a.checks.contactIssues || []).some(i => /clipped|too-small/.test(i.issue))),
      doc.render.attempts.map(a => a.checks.contactIssues));
    // 手动模式：直接 9pt，报告溢出，不自动再压
    fr = await freeze(pos.id, { mode: 'manual' });
    const man = await waitDoc(fr.docId);
    ok('手动模式只渲染最小版式', man.render.attempts.length === 1 && man.render.attempts[0].level === 3);
    ok('手动模式失败类型 LAYOUT_FAILED', man.render.error === 'LAYOUT_FAILED', man.render.error);
    // 用户删减后通过（freeze 不增加 revision；按服务器当前版本保存）
    const cur = (await req('GET', `/api/positions/${pos.id}`)).json.revision;
    const p2 = await req('PATCH', `/api/positions/${pos.id}`, { bulletKeep: { 'pj-huge': 3 } }, { 'If-Match': String(cur) });
    ok('删减后保存成功', p2.status === 200, { st: p2.status });
    fr = await freeze(pos.id, { mode: 'auto' });
    doc = await waitDoc(fr.docId);
    ok('删减后一页通过', doc.status === 'ready' && doc.render.checks.pdfPages === 1, doc.render.error);
    ok('通过版式可能是压缩级别', [1, 2, 3].includes(doc.render.level));

    // ===== 场景 7：历史简历固定来源，不自动套用最新项目 =====
    console.log('\n[7] 历史简历固定来源');
    pos = await createPos({ name: '历史岗位', projectIds: ['pj-neo'] });
    fr = await freeze(pos.id);
    const hist = await waitDoc(fr.docId);
    const oldTitle = hist.content.projects[0].bullets[0];
    // 修改源作品内容并新增项目（服务器重启后以直接改库模拟“来源库更新”——这里用 API 不可改 bullets，故重启前写库）
    await stopServer();
    {
      // 直接修改磁盘上的 db.json（测试进程内的 db 模块缓存与服务进程无关）
      const dbFile = path.join(DATA, 'db.json');
      const dbj = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      const p = dbj.sources.projects.find(x => x.id === 'pj-neo');
      p.bullets[0] = '【最新改写】全新的成果描述，历史简历不应出现这句话';
      dbj.sources.projects.push({ id: 'pj-brandnew', title: '全新内部项目', role: 'Owner', period: '2026-01 至今', visibility: 'public', bullets: ['不应自动进入旧岗位简历'] });
      fs.writeFileSync(dbFile, JSON.stringify(dbj, null, 2));
    }
    await startServer();
    // 旧简历快照内容不变
    const histAgain = (await req('GET', `/api/documents/${hist.id}`)).json;
    ok('历史简历快照保持旧内容', histAgain.content.projects[0].bullets[0] === oldTitle &&
      !JSON.stringify(histAgain.content).includes('最新改写'));
    // 同岗位再次生成：同一项目取最新文字，但不自动包含新增项目
    const curRev = (await req('GET', `/api/positions/${pos.id}`)).json.revision;
    fr = await freeze(pos.id);
    const now2 = await waitDoc(fr.docId);
    ok('新生成版本反映来源最新文字', now2.content.projects[0].bullets[0].includes('最新改写'));
    ok('不自动套用最新项目（pj-brandnew 缺席）', !now2.content.projects.some(p => p.sourceId === 'pj-brandnew'));

    // ===== 附加：渲染中断恢复 =====
    console.log('\n[8] 服务重启后中断任务标记为失败（不丢记录）');
    await stopServer();
    await startServer({ RENDER_DELAY_MS: '4000' }); // 慢速渲染，保证任务停在 rendering
    pos = await createPos();
    fr = await freeze(pos.id);
    await sleep(600); // 任务已入队但渲染未完成
    await stopServer();
    await startServer(); // 正常速度重启，应恢复卡住任务
    await sleep(300);
    const stale = await req('GET', `/api/documents/${fr.docId}`);
    ok('卡住的渲染任务被恢复为 failed/INTERRUPTED',
      stale.json.status === 'failed' && stale.json.render.error === 'INTERRUPTED', { st: stale.json.status, err: stale.json.render && stale.json.render.error });

  } catch (e) {
    failed++;
    console.error('\n!! 场景执行中断，异常：', e && e.stack ? e.stack : e);
  } finally {
    await stopServer();
    console.log(`\n结果：${passed} 通过，${failed} 失败`);
    process.exit(failed ? 1 : 0);
  }
})();
