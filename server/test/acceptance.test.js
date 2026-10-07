import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { db, now } from '../src/db.js';
import { SERVER_SECRET } from '../src/config.js';
// 验收测试：针对运行中的服务器（npm start 后）执行。
// node --test test/acceptance.test.js
function sign(v, exp) {
  const sig = crypto.createHmac('sha256', SERVER_SECRET).update(`${v}.${exp}`).digest('base64url');
  return new URLSearchParams({ v, exp: String(exp), sig }).toString();
}

const BASE = process.env.BASE || 'http://localhost:4178';
const TOK = process.env.OWNER_TOKEN || 'dev-owner-token-2026';
const H = { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' };

async function api(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, j };
}
async function raw(method, p) {
  const res = await fetch(BASE + p, { method, redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}
async function waitTask(tid, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { j } = await api('GET', '/api/tasks/' + tid);
    if (!['queued', 'rendering'].includes(j.status)) return j;
    if (Date.now() > deadline) throw new Error('task timeout ' + tid);
    await new Promise((r) => setTimeout(r, 300));
  }
}
const FULL_IDS = ['edu_1', 'edu_2', 'skl_1', 'skl_2', 'skl_3', 'prj_1', 'prj_2', 'prj_3'];
const CONTACT = { name: '李四', email: 'lisi@example.com', phone: '139 1111 2222', location: '广州', website: 'lisi.dev' };
async function makeResume(ids = FULL_IDS, extra = {}) {
  const { status, j } = await api('POST', '/api/resumes', { job_title: '测试岗位', company: 'ACME', contact: CONTACT, source_ids: ids, ...extra });
  assert.equal(status, 201, JSON.stringify(j));
  return j;
}

// 造若干超长项目条目（用于一页溢出测试）。单条即使很长也可能被排版吸收，
// 因此多条叠加，确保到达最小字号下限后仍超过一页。
function insertLongSources(n = 8) {
  const ids = [];
  const body = '主导超大规模跨端内容平台重构，端到端负责信息架构、设计系统、性能预算与可用性度量，带队完成灰度发布、回归与上线复盘，并推动多团队协作落地与长期维护机制。'.repeat(5);
  for (let i = 0; i < n; i++) {
    const sid = 'prj_long_test_' + i;
    ids.push(sid);
    db.prepare(`INSERT INTO sources(id,kind,title,body,tags,visible,updated_at)
      VALUES(@id,'project',@title,@body,'[]',1,@ts)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, visible=1`)
      .run({ id: sid, title: `超长项目条目（溢出夹具 ${i + 1}）`, body, ts: now() });
  }
  return ids;
}
// 可见性翻转走服务器自己的连接（避免跨进程 WAL 快照滞留影响服务器读取）
async function setVisible(sid, v) {
  const { status } = await api('PATCH', '/api/sources/' + sid, { visible: !!v });
  if (status !== 200) throw new Error('setVisible failed ' + status);
}

// 这些用例共享同一来源库的可见性状态，必须严格串行执行：
// 不在顶层并发注册，而是在单个 test 内按顺序 await。
const __queue = [];
function serialTest(name, fn) { __queue.push({ name, fn }); }
serialTest('1. 冻结快照后来源被改私密/改内容：历史渲染仍用旧固定来源，不自动套用最新', async () => {
  await setVisible('prj_3', 1);
  db.prepare("UPDATE sources SET title=? WHERE id='prj_3'").run('个人创意主页');
  const { resume_id, version } = await makeResume(['prj_3']);
  const before = (await api('GET', '/api/versions/' + version.id)).j.snapshot;
  try {
    // 之后：作品转私密 + 改标题
    await setVisible('prj_3', 0);
    db.prepare("UPDATE sources SET title=? WHERE id='prj_3'").run('【已删除的标题】');
    const after = (await api('GET', '/api/versions/' + version.id)).j.snapshot;
    assert.equal(after.items[0].title, before.items[0].title);
    assert.equal(after.items[0].title.includes('已删除'), false);
    // 标题改动不影响冻结内容，但作品转私密后重新导出会被隐私门拦截（即使内容已冻结）
    const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't1-' + version.id })).j;
    const fin = await waitTask(t.id);
    assert.equal(fin.status, 'failed');
    assert.equal(fin.error_code, 'SOURCE_NOT_VISIBLE');
  } finally {
    await setVisible('prj_3', 1);
    db.prepare("UPDATE sources SET title=? WHERE id='prj_3'").run('个人创意主页');
  }
  });

serialTest('2. 快照生成时作品已私密：拒绝冻结（SOURCE_NOT_VISIBLE）', async () => {
  await setVisible('prj_2', 0);
  const { status, j } = await api('POST', '/api/resumes', { job_title: 'X', contact: CONTACT, source_ids: ['prj_2'] });
  assert.equal(status, 400);
  assert.equal(j.code, 'SOURCE_NOT_VISIBLE');
  assert.equal(j.sources[0].reason, 'private');
  await setVisible('prj_2', 1);
  });

serialTest('3. 渲染排队期间作品转私密：延迟后隐私门拦截，任务失败 SOURCE_NOT_VISIBLE', async () => {
  // delay 在字体加载之后执行（见 renderer 调用顺序），1.5s 足够在渲染前复核处命中
  const { version } = await makeResume(['prj_1']);
  const t = (await api('POST', `/api/versions/${version.id}/render`, {
    idempotency_key: 't3-' + version.id, _test: { delay_ms: 2000 },
  })).j;
  await new Promise((r) => setTimeout(r, 300));
  await setVisible('prj_1', 0);
  const fin = await waitTask(t.id);
  await setVisible('prj_1', 1);
  assert.equal(fin.status, 'failed');
  assert.equal(fin.error_code, 'SOURCE_NOT_VISIBLE');
  });

serialTest('4. 字体下载失败：任务失败 FONT_LOAD_FAILED，且不出 PDF', async () => {
  const { version } = await makeResume();
  const t = (await api('POST', `/api/versions/${version.id}/render`, {
    idempotency_key: 't4-' + version.id,
    _test: { font_url: 'http://127.0.0.1:9/definitely-missing-font.otf' },
  })).j;
  const fin = await waitTask(t.id);
  assert.equal(fin.status, 'failed');
  assert.equal(fin.error_code, 'FONT_LOAD_FAILED');
  assert.equal(fin.pdf_path, null);
  });

serialTest('5. 两个岗位内容并行编辑：乐观锁 409，互不覆盖，各自成版本', async () => {
  const a = await makeResume(['edu_1']);
  // A 与 B 都基于 v1
  const ra = await api('POST', `/api/resumes/${a.resume_id}/versions`, { expected_version: 1, source_ids: ['edu_1'], job_title: '岗位A', contact: CONTACT });
  assert.equal(ra.status, 201);
  assert.equal(ra.j.version, 2);
  const rb = await api('POST', `/api/resumes/${a.resume_id}/versions`, { expected_version: 1, source_ids: ['edu_1'], job_title: '岗位B', contact: CONTACT });
  assert.equal(rb.status, 409);
  assert.equal(rb.j.code, 'VERSION_CONFLICT');
  // B 刷新到 v2 后可提交为 v3
  const rb2 = await api('POST', `/api/resumes/${a.resume_id}/versions`, { expected_version: 2, source_ids: ['edu_1', 'skl_1'], job_title: '岗位B', contact: CONTACT });
  assert.equal(rb2.status, 201);
  assert.equal(rb2.j.version, 3);
  // 两个岗位（不同简历）也能各自独立渲染
  const other = await makeResume(['skl_2']);
  for (const v of [ra.j.id, other.version.id]) {
    const t = (await api('POST', `/api/versions/${v}/render`, { idempotency_key: 't5-' + v })).j;
    const fin = await waitTask(t.id);
    assert.equal(fin.status, 'done', v);
  }
  });

serialTest('6. 导出回执丢失：同一 idempotency_key 幂等取回（不重复出件）', async () => {
  const { version } = await makeResume();
  const key = 'receipt-loss-key-1';
  const t1 = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: key })).j;
  await waitTask(t1.id);
  // 客户端没收到响应，重试：拿回同一任务/回执
  const t2 = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: key })).j;
  assert.equal(t2.id, t1.id);
  assert.ok(t2.receipt && t2.receipt.receipt_id);
  // 或用 key 查询端点
  const t3 = (await api('GET', '/api/tasks/by-key/' + key)).j;
  assert.equal(t3.id, t1.id);
  const n = db.prepare("SELECT COUNT(*) c FROM render_tasks WHERE idempotency_key=?").get(key).c;
  assert.equal(n, 1);
  });

serialTest('7. 受控代理分享：撤销后旧链接 410；访问无鉴权头仍被服务器校验', async () => {
  const { version } = await makeResume();
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't7-' + version.id })).j;
  await waitTask(t.id);
  const sh = (await api('POST', `/api/versions/${version.id}/share`, { mode: 'proxy', ttl_seconds: 3600 })).j;
  assert.equal(sh.links.revocable_instant, true);
  const path = new URL(sh.links.preview).pathname;
  const dl = new URL(sh.links.download).pathname;
  const ok1 = await raw('GET', dl);
  assert.equal(ok1.status, 200);
  assert.equal(ok1.headers.get('content-type'), 'application/pdf');
  assert.match(ok1.headers.get('cache-control') || '', /no-store/);
  assert.ok(ok1.buf.length > 2000);
  // 撤销
  const rv = await api('POST', `/api/shares/${sh.share.token}/revoke`, {});
  assert.equal(rv.status, 200);
  const gone = await raw('GET', dl);
  assert.equal(gone.status, 410);
  const gonePage = await raw('GET', path);
  assert.equal(gonePage.status, 410);
  // 访问审计
  const logs = (await api('GET', `/api/shares/${sh.share.token}/access`)).j;
  assert.ok(logs.some((l) => l.result === 'revoked'));
  });

serialTest('8. 代理链接到期：410 EXPIRED（服务器验证）', async () => {
  const { version } = await makeResume();
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't8-' + version.id })).j;
  await waitTask(t.id);
  const sh = (await api('POST', `/api/versions/${version.id}/share`, { mode: 'proxy', ttl_seconds: 60 })).j;
  db.prepare('UPDATE shares SET expires_at=? WHERE token=?').run(new Date(Date.now() - 1000).toISOString(), sh.share.token);
  const dl = new URL(sh.links.download).pathname;
  const r = await raw('GET', dl);
  assert.equal(r.status, 410);
  });

serialTest('9. 离线签名 URL：有效期内无 DB 可验证，过期失效，篡改签名 403，且不承诺即时撤销', async () => {
  const { version } = await makeResume();
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't9-' + version.id })).j;
  await waitTask(t.id);
  const sh = (await api('POST', `/api/versions/${version.id}/share`, { mode: 'signed', ttl_seconds: 900 })).j;
  assert.equal(sh.links.offline, true);
  assert.equal(sh.links.revocable_instant, false);
  const u = new URL(sh.links.download);
  const ok = await raw('GET', u.pathname + u.search);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control') || '', /must-revalidate/);
  // 篡改签名
  const bad = u.search.replace(/sig=[^&]+/, 'sig=' + 'A'.repeat(24));
  assert.equal((await raw('GET', u.pathname + bad)).status, 403);
  // 过期（用旧时间戳重新正确签名，验证服务器确实检查 exp）
  const expParams = new URLSearchParams(u.search);
  const expUrl = u.pathname + '?' + sign(expParams.get('v'), Date.now() - 1000);
  assert.equal((await raw('GET', expUrl)).status, 410);
  // 即便在 DB 里把对应 share 标撤销，签名有效期内依然可下载（明确边界：不能声称即时撤销）
  db.prepare('UPDATE shares SET revoked=1 WHERE token=?').run(sh.share.token);
  const still = await raw('GET', u.pathname + u.search);
  assert.equal(still.status, 200);
  });

serialTest('10. 一页溢出：到达最小字号下限仍超 -> need_trim + 删减建议，不删字段；手动模式直接报 OVERFLOW', async () => {
  const longIds = insertLongSources(8);
  const { version } = await makeResume([...FULL_IDS, ...longIds]);
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't10-' + version.id })).j;
  const fin = await waitTask(t.id);
  assert.equal(fin.status, 'need_trim');
  assert.equal(fin.error_code, 'NEEDS_TRIM');
  // 已压到最低一级
  assert.equal(fin.level, 3);
  assert.ok(fin.checks.trimSuggestions?.length >= 1);
  // 姓名/联系方式等不可裁切字段仍在 DOM 检查里（没有被系统删掉）
  assert.ok(fin.checks.contact.some((c) => c.field === 'contact.name'));
  assert.ok(fin.checks.contact.some((c) => c.field === 'contact.email'));
  // 没有 PDF 产出
  assert.equal(fin.pdf_path, null);
  // 手动 0 级直接 OVERFLOW_MANUAL
  const t2 = (await api('POST', `/api/versions/${version.id}/render`, { strategy: 'manual', level: 0, idempotency_key: 't10m-' + version.id })).j;
  const f2 = await waitTask(t2.id);
  assert.equal(f2.status, 'failed');
  assert.equal(f2.error_code, 'OVERFLOW_MANUAL');
  for (const x of longIds) db.prepare('DELETE FROM sources WHERE id=?').run(x);
  });

serialTest('11. 渲染后检查：PDF 实际页数必须为 1（不接受多页），且最小字号约束生效', async () => {
  const { version } = await makeResume();
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't11-' + version.id })).j;
  const fin = await waitTask(t.id);
  assert.equal(fin.status, 'done');
  assert.equal(fin.receipt.pages, 1);
  const name = fin.checks.contact.find((c) => c.field === 'contact.name');
  assert.ok(name.fontPt >= 15 - 0.1, '姓名最小 15pt');
  const email = fin.checks.contact.find((c) => c.field === 'contact.email');
  assert.ok(email.fontPt >= 9 - 0.1, '联系方式最小 9pt');
  });

serialTest('12. 缺字（豆腐块）：含未覆盖字符 -> GLYPH_MISSING 失败', async () => {
  // 用一个含 emoji 的“技能”名（Noto CJK 不含彩色 emoji 字形）
  const sid = 'skl_glyph_test';
  db.prepare(`INSERT INTO sources(id,kind,title,body,tags,visible,updated_at)
    VALUES(@id,'skill',@title,'','[]',1,@ts)
    ON CONFLICT(id) DO UPDATE SET title=excluded.title, visible=1`)
    .run({ id: sid, title: '表情符号技能 🎉🎉🎉', ts: now() });
  const { version } = await makeResume([...FULL_IDS, sid]);
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't12-' + version.id })).j;
  const fin = await waitTask(t.id);
  assert.equal(fin.status, 'failed');
  assert.equal(fin.error_code, 'GLYPH_MISSING');
  db.prepare('DELETE FROM sources WHERE id=?').run(sid);
  });

serialTest('13. 网页状态区分：草稿 / 已生成 / 已分享', async () => {
  const { resume_id, version } = await makeResume(['edu_1']);
  const detail = await api('GET', '/api/resumes/' + resume_id);
  assert.equal(detail.j.versions.find((x) => x.version === 1).status, 'draft');
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't13-' + version.id })).j;
  await waitTask(t.id);
  const d2 = await api('GET', '/api/resumes/' + resume_id);
  assert.equal(d2.j.versions.find((x) => x.version === 1).status, 'generated');
  await api('POST', `/api/versions/${version.id}/share`, { mode: 'proxy', ttl_seconds: 600 });
  const d3 = await api('GET', '/api/resumes/' + resume_id);
  assert.equal(d3.j.versions.find((x) => x.version === 1).status, 'shared');
  });

serialTest('14. 未授权访问 API 被拒；静态白名单不暴露 server/data', async () => {
  const r = await fetch(BASE + '/api/sources');
  assert.equal(r.status, 401);
  const dbFile = await raw('GET', '/../server/data/app.db');
  assert.equal(dbFile.status >= 400, true);
  });

serialTest('15. 机主一次性下载票：鉴权换取、用后即焚、过期 410', async () => {
  const { version } = await makeResume();
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't15-' + version.id })).j;
  await waitTask(t.id);
  // 未鉴权不能直接换票
  assert.equal((await fetch(`${BASE}/api/versions/${version.id}/download-ticket`, { method: 'POST' })).status, 401);
  const tk = (await api('POST', `/api/versions/${version.id}/download-ticket`, {})).j;
  assert.match(tk.url, /\/dl\//);
  const path = new URL(tk.url).pathname;
  const r1 = await raw('GET', path);
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('content-type'), 'application/pdf');
  // 用后即焚
  const r2 = await raw('GET', path);
  assert.equal(r2.status, 410);
  // 网页与脚本可匿名获取（静态）
  assert.equal((await raw('GET', '/resume.html')).status, 200);
  assert.equal((await raw('GET', '/js/resume.js')).status, 200);
  // 服务器数据目录不在静态白名单
  assert.equal((await raw('GET', '/server/data/app.db')).status, 404);
  });

serialTest('16. 受控代理：作品分享后转私密，旧链接立即 410', async () => {
  const { version } = await makeResume(['prj_3']);
  const t = (await api('POST', `/api/versions/${version.id}/render`, { idempotency_key: 't16-' + version.id })).j;
  await waitTask(t.id);
  const sh = (await api('POST', `/api/versions/${version.id}/share`, { mode: 'proxy', ttl_seconds: 3600 })).j;
  const dl = new URL(sh.links.download).pathname;
  assert.equal((await raw('GET', dl)).status, 200);
  await setVisible('prj_3', 0);
  const gone = await raw('GET', dl);
  assert.equal(gone.status, 410);
  await setVisible('prj_3', 1);
  });

// 全部入队后，在单个顶层 test 里顺序执行，用子断言保留用例名
test('岗位简历工作流验收（串行，共 ' + __queue.length + ' 项）', async (t) => {
  for (const __t of __queue) {
    await t.test(__t.name, __t.fn);
  }
});
