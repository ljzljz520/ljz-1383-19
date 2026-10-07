const $ = (s) => document.querySelector(s);
const API = '/api';
let token = localStorage.getItem('owner_token') || '';
$('#token').value = token;
let sources = [], resumes = [], currentVersionByResume = {};

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = 'toast'), 3600);
}
$('#saveToken').onclick = () => { token = $('#token').value.trim(); localStorage.setItem('owner_token', token); toast('Token 已保存', 'ok'); load(); };

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || res.statusText), { status: res.status, body: j });
  return j;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const KIND = { education: '教育', skill: '技能', project: '项目' };
const STATUS = { draft: ['b-draft', '草稿'], generated: ['b-generated', '已生成'], shared: ['b-shared', '已分享'] };
function fmt(iso) { return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

async function loadSources() {
  sources = await api('GET', '/sources');
  const groups = ['education', 'skill', 'project'].map((kind) => {
    const items = sources.filter((s) => s.kind === kind).map((s) => `
      <label class="src">
        <input type="checkbox" value="${s.id}" ${s.visible ? '' : 'disabled'}>
        <span>
          <span class="k">${KIND[kind]}</span>
          <span class="t">${esc(s.title)}</span>${s.visible ? '' : '<span class="priv">（私密，不可选）</span>'}
          <div class="b">${esc(s.body)}</div>
        </span>
      </label>`).join('');
    return `<div style="margin:6px 0"><b style="font-size:.8rem">${KIND[kind]}</b>${items}</div>`;
  }).join('');
  $('#picker').innerHTML = groups;
}
function readForm() {
  return {
    job_title: $('#jobTitle').value.trim(),
    company: $('#company').value.trim(),
    contact: {
      name: $('#cName').value.trim(), email: $('#cEmail').value.trim(),
      phone: $('#cPhone').value.trim(), location: $('#cLocation').value.trim(), website: $('#cWebsite').value.trim(),
    },
    source_ids: [...document.querySelectorAll('#picker input:checked')].map((i) => i.value),
  };
}

$('#createResume').onclick = async () => {
  const f = readForm();
  if (!f.job_title || !f.contact.name || !f.contact.email || !f.contact.phone) return toast('岗位、姓名、邮箱、电话必填', 'err');
  if (!f.source_ids.length) return toast('至少选择一个教育/技能/项目条目', 'err');
  try {
    const r = await api('POST', '/resumes', f);
    currentVersionByResume[r.resume_id] = r.version.version;
    toast('已冻结为 v1 草稿', 'ok');
    await loadResumes();
  } catch (e) {
    if (e.body?.code === 'SOURCE_NOT_VISIBLE') return toast('所选作品已转私密，无法冻结：' + e.body.sources.map((x) => x.id).join(', '), 'err');
    toast('创建失败：' + e.message, 'err');
  }
};

async function renderVersion(rid, vid, strategy = 'auto', idem) {
  const t = await api('POST', `/versions/${vid}/render`, { idempotency_key: idem || null, strategy });
  return pollTask(t.id);
}
async function pollTask(tid) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    const t = await api('GET', '/tasks/' + tid);
    if (['done', 'need_trim', 'failed'].includes(t.status)) return t;
  }
}

function checksHTML(task) {
  const c = task.checks || {};
  const li = [];
  li.push(`溢出项：${(c.overflow || []).length}`);
  li.push(`缺字（fontkit+光栅化）：${(c.fontkitMissing || []).length + (c.glyphs?.blank400?.length || 0)}`);
  li.push(`PDF 实际页数：${c.pdfPages ?? '-'}`);
  li.push(`字体已加载：${c.fontsLoaded ? '是' : '否'}`);
  const bad = (c.contact || []).filter((x) => !x.ok);
  li.push(`联系方式字段：${(c.contact || []).length}，不达标 ${bad.length}`);
  const level = task.level != null ? `（已试到第 ${task.level} 级版式）` : '';
  let extra = '';
  if (task.status === 'need_trim' && c.trimSuggestions?.length) {
    extra = `<div class="suggest"><b>需要你删减（系统不裁切）：</b><ul>${c.trimSuggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
      <div class="muted" style="margin-top:6px">请回到上面取消勾选部分项目/精简描述后，另存新版本再导出。</div></div>`;
  }
  if (task.status === 'failed' && task.error_code === 'FONT_LOAD_FAILED') extra = `<div class="suggest">字体下载失败，已中止渲染（不使用可能产生豆腐块的回退字体）。</div>`;
  if (task.status === 'failed' && task.error_code === 'GLYPH_MISSING') extra = `<div class="suggest">检测到字体缺字（.notdef），请替换特殊字符或补字库。</div>`;
  return `<div class="checks">渲染后检查报告 ${level}<ul>${li.map((x) => `<li>${x}</li>`).join('')}</ul>${extra}</div>`;
}

async function doRender(rid, vid, btn, strategy) {
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>后台渲染中…';
  try {
    const idem = 'ui-' + vid + '-' + Date.now();
    const task = await renderVersion(rid, vid, strategy, idem);
    if (task.status === 'done') toast(`PDF 已生成（${task.receipt?.checks?.pages === 1 ? '确认为一页' : '页数异常'}）`, 'ok');
    else if (task.status === 'need_trim') toast('已到最小字号仍超一页，请按建议删减', 'warn');
    else toast('渲染失败：' + (task.error || task.error_code), 'err');
    await loadResumes();
  } catch (e) { toast('渲染失败：' + e.message, 'err'); }
}

async function doShare(vid, mode, ttl, btn) {
  btn.disabled = true;
  try {
    const r = await api('POST', `/versions/${vid}/share`, { mode, ttl_seconds: ttl });
    const l = r.links;
    const lines = [];
    lines.push(`<b>${mode === 'proxy' ? '受控代理（可即时撤销）' : '离线签名短链（有效期内不可即时撤销）'}</b>`);
    if (l.preview) lines.push(`预览：<a href="${l.preview}" target="_blank">${esc(l.preview)}</a>`);
    lines.push(`下载：<a href="${l.download}" target="_blank">${esc(l.download)}</a>`);
    lines.push(`到期：${fmt(l.expires_at)}`);
    lines.push(`缓存边界：${esc(l.cache_policy)}`);
    toast('分享链接已创建', 'ok');
    await loadResumes();
  } catch (e) { toast('分享失败：' + e.message + (e.body?.code ? '（' + e.body.code + '）' : ''), 'err'); btn.disabled = false; }
}

async function downloadPdf(vid, btn) {
  btn.disabled = true;
  try {
    const r = await api('POST', `/versions/${vid}/download-ticket`, {});
    toast('已生成一次性下载链接（60 秒内有效）；已下载副本无法远程收回', 'ok');
    window.open(r.url, '_blank');
  } catch (e) { toast('下载失败：' + e.message, 'err'); }
  finally { setTimeout(() => (btn.disabled = false), 1500); }
}

async function revoke(tokenVal, btn) {
  btn.disabled = true;
  try { await api('POST', `/shares/${tokenVal}/revoke`, {}); toast('受控代理链接已撤销，旧链接立即 410', 'ok'); await loadResumes(); }
  catch (e) { toast('撤销失败：' + e.message, 'err'); btn.disabled = false; }
}

function renderResumes() {
  if (!resumes.length) { $('#resumes').innerHTML = '<span class="muted">还没有岗位简历。</span>'; return; }
  $('#resumes').innerHTML = resumes.map((r) => {
    const cur = r.current_version;
    const versions = r.versions.slice().sort((a, b) => b.version - a.version).map((v) => {
      const [cls, label] = STATUS[v.status] || ['b-draft', v.status];
      return `<div class="ver">
        <div class="line">
          <span>v${v.version} · ${esc(v.job_title)} <span class="badge ${cls}">${label}</span></span>
          <span>${fmt(v.created_at)}</span>
        </div>
        <div class="line">
          <span class="muted">模板 onepage-v1@1.0.0（冻结）</span>
          <span>
            <button data-act="render" data-rid="${r.id}" data-vid="${v.id}">导出一页 PDF</button>
            <button data-act="shareProxy" data-vid="${v.id}">分享(代理·7天)</button>
            <button data-act="shareSigned" data-vid="${v.id}">签名短链(15分钟)</button>
          </span>
        </div>
      </div>`;
    }).join('');
    return `<div class="pos">
      <header>
        <span class="jt">${esc(r.job_title)} ${r.company ? '· ' + esc(r.company) : ''} <span class="pill">当前 v${cur}</span></span>
        <span>
          <button data-act="edit" data-rid="${r.id}">基于当前版本改选字段</button>
        </span>
      </header>
      ${versions}
    </div>`;
  }).join('');
}

$('#resumes').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const act = b.dataset.act, rid = b.dataset.rid, vid = b.dataset.vid;
  if (act === 'render') return doRender(rid, vid, b, 'auto');
  if (act === 'shareProxy') return doShare(vid, 'proxy', 7 * 86400, b);
  if (act === 'shareSigned') return doShare(vid, 'signed', 900, b);
  if (act === 'edit') return startEdit(rid, b);
  if (act === 'saveVersion') return saveVersion(rid, b);
  if (act === 'cancelEdit') { delete b.dataset.rid; return loadResumes(); }
  if (act === 'revoke') return revoke(b.dataset.token, b);
  if (act === 'download') return downloadPdf(vid, b);
});

async function startEdit(rid, btn) {
  const r = resumes.find((x) => x.id === rid);
  const expected = r.current_version;
  const latest = r.versions.find((x) => x.version === expected);
  $('#jobTitle').value = latest.job_title || r.job_title;
  $('#company').value = latest.company || r.company || '';
  const detail = await api('GET', '/resumes/' + rid);
  const full = detail.versions.find((x) => x.version === expected);
  for (const [k, sel] of [['cName', 'name'], ['cEmail', 'email'], ['cPhone', 'phone'], ['cLocation', 'location'], ['cWebsite', 'website']]) {
    $('#' + k).value = full.contact?.[sel] || '';
  }
  const sel = new Set(full.source_ids || []);
  document.querySelectorAll('#picker input').forEach((i) => (i.checked = sel.has(i.value)));
  btn.textContent = `保存为新版本（基于 v${expected}，冲突将 409）`;
  btn.dataset.act = 'saveVersion';
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast('已载入 v' + expected + '，若期间他人保存过会收到 409，不会互相覆盖', 'warn');
}

async function saveVersion(rid, btn) {
  const r = resumes.find((x) => x.id === rid);
  const expected_version = r.current_version;
  const f = readForm();
  btn.disabled = true;
  try {
    await api('POST', `/resumes/${rid}/versions`, { ...f, expected_version });
    toast('已另存为 v' + (expected_version + 1), 'ok');
    await loadResumes();
  } catch (e) {
    if (e.status === 409) toast('版本冲突（409）：岗位已被另一方更新，请重新“基于当前版本改选”', 'err');
    else if (e.body?.code === 'SOURCE_NOT_VISIBLE') toast('所选作品已转私密：' + e.body.sources.map((x) => x.id).join(', '), 'err');
    else toast('保存失败：' + e.message, 'err');
    btn.disabled = false;
  }
}

// 为每个版本注入最近一次渲染结果（检查报告 + 下载）
async function decorateTasks() {
  for (const r of resumes) {
    for (const v of r.versions) {
      const host = document.querySelector(`[data-act="render"][data-vid="${v.id}"]`)?.closest('.ver');
      if (!host) continue;
      let slot = host.querySelector('.task-slot');
      if (!slot) { slot = document.createElement('div'); slot.className = 'task-slot'; host.appendChild(slot); }
      try {
        const tasks = await api('GET', `/versions/${v.id}/tasks`);
        const t = tasks[0];
        if (!t) { slot.innerHTML = '<div class="muted" style="margin-top:6px">尚未导出。</div>'; continue; }
        const badge = t.status === 'done' ? '<span class="badge b-generated">已生成</span>'
          : t.status === 'need_trim' ? '<span class="badge b-need">需删减</span>'
          : t.status === 'failed' ? '<span class="badge b-failed">失败</span>'
          : '<span class="badge b-draft">进行中</span>';
        const dl = t.status === 'done'
          ? ` <button type="button" data-act="download" data-vid="${v.id}">下载 PDF（已下载副本不可远程收回）</button>` : '';
        slot.innerHTML = `<div style="margin-top:6px">${badge} <span class="muted">${fmt(t.updated_at)}</span>${dl}</div>` + checksHTML(t);
      } catch { /* 忽略单个版本加载失败 */ }
    }
  }
}

async function loadResumes() {
  resumes = await api('GET', '/resumes');
  renderResumes();
  await decorateTasks();
  const shares = await api('GET', '/shares').catch(() => []);
  for (const s of shares) {
    const boxId = 'links-' + s.resume_version_id;
    let box = document.getElementById(boxId);
    if (!box) {
      const btn = document.querySelector(`[data-act="shareProxy"][data-vid="${s.resume_version_id}"]`);
      if (!btn) continue;
      const host = btn.closest('.ver');
      box = document.createElement('div'); box.id = boxId; host.appendChild(box);
    }
    const expired = new Date(s.expires_at).getTime() < Date.now();
    box.innerHTML += `<div class="linkbox">${s.mode === 'proxy' ? '代理' : '签名'}链接 · ${s.revoked ? '<b style="color:var(--bad)">已撤销</b>' : expired ? '<b style="color:var(--warn)">已过期</b>' : '有效'} · 到期 ${fmt(s.expires_at)}
      ${s.mode === 'proxy' && !s.revoked && !expired ? `<br><button data-act="revoke" data-token="${s.token}">立即撤销此代理链接</button>` : ''}
      <div class="muted">${s.mode === 'signed' ? '离线签名：有效期内不能即时撤销；已下载的 PDF 无法远程收回' : '代理：no-store，撤销/到期即时生效'}</div></div>`;
  }
  await decorateTasks();
}

async function load() {
  if (!token) return toast('请先输入 Owner Token', 'warn');
  try { await loadSources(); await loadResumes(); }
  catch (e) { if (e.status === 401 || e.message.includes('401')) toast('Token 无效', 'err'); else toast('加载失败：' + e.message, 'err'); }
}
if (token) load();
