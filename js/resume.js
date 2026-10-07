/* 岗位简历工作台前端逻辑 */
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const state = {
    key: localStorage.getItem('resume_admin_key') || '',
    sources: null, positions: [], documents: [], shares: [], events: [],
    selectedPosId: null, editing: null, // 本地编辑副本
    fontFailSim: false,
  };
  $('#admin-key').value = state.key;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '';

  async function api(method, path, body, headers = {}) {
    const opt = { method, headers: { 'X-Admin-Key': state.key, ...headers } };
    if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(path, opt);
    if (res.status === 401) throw new Error('未授权：请填写正确的管理密钥');
    const rid = res.headers.get('x-receipt-id');
    const data = res.status === 204 ? null : await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || '请求失败'), { status: res.status, data, receiptId: rid });
    return { data, receiptId: rid };
  }

  const statusPill = s => ({ rendering: '生成中', ready: '已生成', failed: '失败' }[s] || s);
  const sharePill = sh => {
    if (sh.revoked) return '<span class="pill revoked">已撤销</span>';
    if (new Date(sh.expiresAt) < new Date()) return '<span class="pill expired">已过期</span>';
    return '<span class="pill shared">生效中</span>';
  };

  // ---------------- 加载 ----------------
  async function loadAll() {
    if (!state.key) { window.showToast && showToast('请先填写管理密钥', 'error'); return; }
    try {
      const [s, p, d, sh, ev] = await Promise.all([
        api('GET', '/api/sources'), api('GET', '/api/positions'), api('GET', '/api/documents'),
        api('GET', '/api/shares'), api('GET', '/api/events'),
      ]);
      state.sources = s.data; state.positions = p.data; state.documents = d.data;
      state.shares = sh.data; state.events = ev.data;
      renderPositions(); renderDocs(); renderShares(); renderEvents(); renderSources();
    } catch (e) { window.showToast && showToast(e.message, 'error'); }
  }

  function renderSources() {
    const el = $('#pos-list');
    // 源作品可见性管理小面板
    let panel = $('#source-admin');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'source-admin';
      panel.className = 'rs-source-admin';
      panel.style.cssText = 'margin-top:14px;border-top:1px solid rgba(148,163,184,.2);padding-top:10px';
      el.parentNode.insertBefore(panel, el.nextSibling);
    }
    const projs = state.sources.projects;
    panel.innerHTML = `<div class="gt" style="font-size:.78rem;color:#a5b4fc;margin-bottom:6px">源作品可见性（渲染瞬间为私密则不进入快照）</div>` +
      projs.map(p => `<label class="opt"><input type="checkbox" data-priv="${p.id}" ${p.visibility === 'private' ? 'checked' : ''}>
        <span>${esc(p.title)} <span class="meta">${p.visibility === 'private' ? '<span class="priv">当前私密</span>' : '公开'}</span></span></label>`).join('');
    panel.querySelectorAll('input[data-priv]').forEach(cb => cb.addEventListener('change', async () => {
      try {
        await api('POST', `/api/sources/projects/${cb.dataset.priv}/visibility`, { visibility: cb.checked ? 'private' : 'public' });
        window.showToast && showToast(`「${projs.find(p => p.id === cb.dataset.priv).title}」已${cb.checked ? '设为私密' : '恢复公开'}`, cb.checked ? 'error' : 'success');
        await loadAll();
      } catch (e) { window.showToast && showToast(e.message, 'error'); cb.checked = !cb.checked; }
    }));
  }

  function renderPositions() {
    const ul = $('#pos-list');
    if (!state.positions.length) { ul.innerHTML = '<li class="rs-hint">还没有岗位，点击右上角新建。</li>'; return; }
    ul.innerHTML = state.positions.map(p => {
      const docs = state.documents.filter(d => d.positionId === p.id);
      const hasShare = docs.some(d => state.shares.some(s => s.docId === d.id && !s.revoked && new Date(s.expiresAt) > new Date()));
      return `<li class="rs-item ${state.selectedPosId === p.id ? 'active' : ''}" data-pos="${p.id}">
        <div class="t">${esc(p.name)}</div>
        <div class="m"><span class="rev">rev ${p.revision}</span>
          <span class="pill draft">草稿</span>
          ${docs.length ? `<span class="pill ${docs[0].status}">${statusPill(docs[0].status)}</span>` : ''}
          ${hasShare ? '<span class="pill shared">已分享</span>' : ''}
          <span>${fmt(p.updatedAt)}</span></div></li>`;
    }).join('');
    ul.querySelectorAll('[data-pos]').forEach(li => li.addEventListener('click', () => selectPosition(li.dataset.pos)));
  }

  // ---------------- 编辑器 ----------------
  function selectPosition(id) {
    state.selectedPosId = id;
    const pos = state.positions.find(p => p.id === id);
    state.editing = JSON.parse(JSON.stringify(pos));
    $('#editor-card').hidden = false;
    renderPositions();
    renderEditor();
  }

  function renderEditor(conflict) {
    const e = state.editing;
    const s = state.sources;
    $('#rev-info').textContent = `当前基于草稿 revision ${e.revision}。编辑后保存；若他人并行改动导致冲突，会提示而不是静默覆盖。`;
    const pickList = (kind, items) => items.map(it => {
      const checked = e[kind].includes(it.id) ? 'checked' : '';
      return `<label class="opt"><input type="checkbox" data-kind="${kind}" value="${it.id}" ${checked}>
        <span>${editorLabel(kind, it)}</span></label>`;
    }).join('');
    $('#editor').innerHTML = `
      ${conflict ? `<div class="check-report bad">⚠ 并行编辑冲突：服务器上该岗位已是 rev ${conflict.server}（你基于 rev ${conflict.mine}）。
        下方展示的是服务器最新内容，请重新选择后保存；不会静默覆盖他人改动。</div>` : ''}
      <div class="fld"><label class="f">岗位名称</label><input type="text" id="ed-name" value="${esc(e.name)}"></div>
      <div class="fld"><label class="f">求职意向（抬头）</label><input type="text" id="ed-target" value="${esc(e.target || '')}"></div>
      <div class="fgroup"><div class="gt">教育经历</div>${pickList('eduIds', s.educations)}</div>
      <div class="fgroup"><div class="gt">技能</div>${pickList('skillIds', s.skills)}</div>
      <div class="fgroup"><div class="gt">项目（私密源不可选；条目可限制条数）</div>
        ${s.projects.map(p => {
          const disabled = p.visibility === 'private';
          const checked = e.projectIds.includes(p.id) && !disabled ? 'checked' : '';
          const keep = e.bulletKeep[p.id] || p.bullets.length;
          return `<label class="opt" style="${disabled ? 'opacity:.55' : ''}">
            <input type="checkbox" data-kind="projectIds" value="${p.id}" ${checked} ${disabled ? 'disabled' : ''}>
            <span>${esc(p.title)} ${disabled ? '<span class="priv">私密 · 不可进入简历</span>' : ''}
              <span class="meta">${esc(p.role)} · ${esc(p.period)}（${p.bullets.length} 条）</span>
              ${!disabled ? `<span class="bcount">保留条目数
                <select data-keep="${p.id}" style="background:rgba(15,23,42,.6);color:#e2e8f0;border-radius:6px">
                  ${p.bullets.map((_, i) => `<option value="${i + 1}" ${keep === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}
                </select></span>` : ''}
            </span></label>`;
        }).join('')}
      </div>
      <details style="font-size:.78rem"><summary>演练选项</summary>
        <label class="opt"><input type="checkbox" id="ed-fontfail"> 模拟字体下载失败（验证字体故障时阻断导出）</label>
      </details>`;

    $('#ed-name').addEventListener('input', v => state.editing.name = v.target.value);
    $('#ed-target').addEventListener('input', v => state.editing.target = v.target.value);
    $$('#editor input[data-kind]').forEach(cb => cb.addEventListener('change', () => {
      const k = cb.dataset.kind, arr = state.editing[k];
      const i = arr.indexOf(cb.value);
      if (cb.checked && i < 0) arr.push(cb.value);
      if (!cb.checked && i >= 0) arr.splice(i, 1);
    }));
    $$('#editor select[data-keep]').forEach(sel => sel.addEventListener('change', () => {
      state.editing.bulletKeep[sel.dataset.keep] = Number(sel.value);
    }));
    $('#ed-fontfail').checked = state.fontFailSim;
    $('#ed-fontfail').addEventListener('change', v => { state.fontFailSim = v.target.checked; });
  }
  function editorLabel(kind, it) {
    if (kind === 'eduIds') return `${esc(it.school)} · ${esc(it.degree)} · ${esc(it.major)} <span class="meta">${esc(it.period)}</span>`;
    if (kind === 'skillIds') return `${esc(it.group)} <span class="meta">${esc(it.items)}</span>`;
    return esc(it.title);
  }

  async function savePosition() {
    const e = state.editing;
    try {
      const { data } = await api('PATCH', `/api/positions/${e.id}`,
        { name: e.name, target: e.target, eduIds: e.eduIds, skillIds: e.skillIds, projectIds: e.projectIds, bulletKeep: e.bulletKeep },
        { 'If-Match': String(e.revision) });
      Object.assign(state.editing, data);
      window.showToast && showToast(`已保存（rev ${data.revision}）`, 'success');
      await loadAll();
      selectPosition(data.id);
    } catch (err) {
      if (err.status === 409) {
        renderEditor({ mine: e.revision, server: err.data.current });
        window.showToast && showToast('检测到并行编辑冲突，已加载服务器版本', 'error');
      } else window.showToast && showToast(err.message, 'error');
    }
  }

  async function freeze(mode) {
    await savePositionSilent();
    const e = state.editing;
    try {
      const { data } = await api('POST', `/api/positions/${e.id}/freeze`, { mode, simulateFontFail: state.fontFailSim });
      window.showToast && showToast('已冻结内容并提交后台渲染任务', 'success');
      pollDoc(data.docId);
    } catch (err) { window.showToast && showToast(err.message, 'error'); }
  }
  // 静默保存：冲突时直接报错（freeze 前）
  async function savePositionSilent() {
    const e = state.editing;
    const { data } = await api('PATCH', `/api/positions/${e.id}`,
      { name: e.name, target: e.target, eduIds: e.eduIds, skillIds: e.skillIds, projectIds: e.projectIds, bulletKeep: e.bulletKeep },
      { 'If-Match': String(e.revision) });
    Object.assign(state.editing, data);
    state.positions = state.positions.map(p => p.id === data.id ? data : p);
  }

  let pollTimer = null;
  function pollDoc(docId, cb) {
    clearInterval(pollTimer);
    let n = 0;
    pollTimer = setInterval(async () => {
      n++;
      try {
        const { data } = await api('GET', `/api/documents/${docId}`);
        state.documents = state.documents.map(d => d.id === docId ? data : d);
        renderDocs();
        if (data.status !== 'rendering' || n > 60) {
          clearInterval(pollTimer);
          renderPositions();
          cb && cb(data);
        }
      } catch { clearInterval(pollTimer); }
    }, 1000);
  }

  // ---------------- 生成物 ----------------
  function checkReport(d) {
    const r = d.render || {};
    if (d.status === 'rendering') return '<div class="check-report" style="background:rgba(120,53,15,.2)">后台渲染中… 完成后展示渲染后检查报告</div>';
    const c = r.checks || {};
    if (d.status === 'ready') {
      return `<div class="check-report ok">✓ 一页校验通过（版式级别 ${r.level}，PDF 实际页数 ${c.pdfPages}）
· 溢出元素 ${c.overflow} · 缺字 ${(c.missingChars || []).length} · 最小字号 ${c.minSeenPt}pt · 联系方式问题 ${(c.contactIssues || []).length}
SHA256 ${(r.sha256 || '').slice(0, 20)}… · ${r.size} 字节</div>`;
    }
    return `<div class="check-report bad">✗ ${esc(r.message || r.error || '生成失败')}
<details><summary>查看渲染后检查报告（实际测量，非字符数）</summary><pre>${esc(JSON.stringify(c, null, 2))}</pre></details></div>`;
  }

  function renderDocs() {
    const ul = $('#doc-list');
    if (!state.documents.length) { ul.innerHTML = '<li class="rs-hint">尚无已生成简历。</li>'; return; }
    ul.innerHTML = state.documents.map(d => `
      <li class="rs-item" style="cursor:default">
        <div class="t">${esc(d.positionName)} <span class="m">v${d.positionRev} · 冻结于 ${fmt(d.createdAt)}</span></div>
        <div class="m"><span class="pill ${d.status}">${statusPill(d.status)}</span>${d.status === 'ready' ? `版式 ${d.render.level}` : ''}</div>
        ${checkReport(d)}
        <div class="doc-actions">
          ${d.status === 'ready' ? `
            <a class="btn-mini primary" href="/api/documents/${d.id}/pdf" data-dl="${d.id}">下载 PDF</a>
            <button class="btn-mini" data-receipts="${d.id}">导出回执</button>
            <button class="btn-mini" data-share-doc="${d.id}">创建分享链接</button>` :
            (d.status === 'failed' && d.render.error !== 'FONT_UNAVAILABLE' ? `<button class="btn-mini" data-retry="${d.positionId}" data-mode="auto">重新自动压缩</button><button class="btn-mini warn" data-retry="${d.positionId}" data-mode="manual">最小版式重试</button>` :
             d.status === 'failed' ? `<button class="btn-mini" data-retry="${d.positionId}" data-mode="auto">修复字体后重试</button>` : '')}
        </div>
        <div class="share-create" id="share-box-${d.id}" hidden>
          <select data-mode>
            <option value="proxy">受控下载代理（撤销即时生效，默认 7 天）</option>
            <option value="signed">独立签名直链（≤10 分钟，有效期内不可即时撤销）</option>
          </select>
          <input type="number" data-ttl min="60" max="604800" placeholder="有效期秒（可选）" style="width:130px;padding:6px;border-radius:8px;background:rgba(15,23,42,.6);color:#e2e8f0;border:1px solid rgba(148,163,184,.35)">
          <button class="btn-mini primary" data-mkshare="${d.id}">生成</button>
        </div>
        <div id="receipts-${d.id}"></div>
      </li>`).join('');

    $$('[data-ShareDoc], [data-share-doc]').forEach(b => b.addEventListener('click', () => {
      const box = $(`#share-box-${b.dataset.shareDoc}`); box.hidden = !box.hidden;
    }));
    $$('[data-mkshare]').forEach(b => b.addEventListener('click', async () => {
      const box = $(`#share-box-${b.dataset.mkshare}`);
      const mode = box.querySelector('[data-mode]').value;
      const ttl = Number(box.querySelector('[data-ttl]').value) || undefined;
      try {
        await api('POST', '/api/shares', { docId: b.dataset.mkshare, mode, ttlSeconds: ttl });
        window.showToast && showToast('分享链接已创建', 'success');
        await loadAll();
      } catch (e) { window.showToast && showToast(e.message, 'error'); }
    }));
    $$('[data-receipts]').forEach(b => b.addEventListener('click', () => showReceipts(b.dataset.receipts)));
    $$('[data-retry]').forEach(b => b.addEventListener('click', async () => {
      state.selectedPosId = b.dataset.retry;
      await selectPosition(b.dataset.retry);
      await freeze(b.dataset.mode);
    }));
    $$('a[data-dl]').forEach(a => a.addEventListener('click', () => {
      // 下载请求经 fetch 以便读取 x-receipt-id（a 标签拿不到响应头）
      a.addEventListener('click', ev => ev.preventDefault());
    }));
  }

  // 用 fetch 下载，捕获并持久展示导出回执（解决“回执丢失”：服务端有记录，可重取）
  async function downloadPdf(docId) {
    const res = await fetch(`/api/documents/${docId}/pdf`, { headers: { 'X-Admin-Key': state.key } });
    if (!res.ok) { window.showToast && showToast('PDF 工件缺失，请重新生成', 'error'); return null; }
    const receiptId = res.headers.get('x-receipt-id');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `简历-${docId}.pdf`; a.click();
    window.showToast && showToast(`已导出，回执号 ${receiptId.slice(0, 10)}…（可在“导出回执”中重取）`, 'success');
    return receiptId;
  }
  async function showReceipts(docId) {
    const box = $(`#receipts-${docId}`);
    try {
      const { data } = await api('GET', `/api/documents/${docId}/receipts`);
      box.innerHTML = `<div class="rs-hint" style="margin:6px 0 0">导出回执（服务端持久化，丢失可在此重取；已下载的 PDF 无法远程收回）：
        ${data.length ? data.map(r => `<div>· ${r.id.slice(0, 14)}… ${fmt(r.at)} · sha ${(r.sha256 || '').slice(0, 12)} · ${r.size}B</div>`).join('') : '<div>暂无导出记录</div>'}</div>`;
    } catch (e) { window.showToast && showToast(e.message, 'error'); }
  }

  // ---------------- 分享 ----------------
  function renderShares() {
    const ul = $('#share-list');
    if (!state.shares.length) { ul.innerHTML = '<li class="rs-hint">尚无分享链接。</li>'; return; }
    ul.innerHTML = state.shares.map(sh => {
      const doc = state.documents.find(d => d.id === sh.docId);
      const token = sh.token;
      return `<li class="rs-item" style="cursor:default">
        <div class="t">${esc(doc ? doc.positionName : sh.docId)} ${sharePill(sh)}</div>
        <div class="m"><span>${sh.mode === 'signed' ? '签名直链' : '下载代理'}</span><span>到期 ${fmt(sh.expiresAt)}</span><span>访问 ${sh.accesses.length}</span></div>
        <div class="share-line">
          预览页：<a href="/s/${token}" target="_blank">/s/${token}</a>
          ${sh.mode === 'proxy' ? `<br>PDF 代理：<a href="/p/${token}/pdf" target="_blank">/p/${token}/pdf</a>` : ''}
          ${sh.signedUrl ? `<br>签名直链：<a href="${sh.signedUrl}" target="_blank">${sh.signedUrl.slice(0, 60)}…</a>` : ''}
        </div>
        ${sh.mode === 'signed' ? '<div class="share-note">签名直链可离线验证有效期：<u>有效期内无法保证即时撤销</u>，且允许私有缓存至到期；请只短时间分享。</div>'
          : '<div class="share-note">代理链接每次访问都经服务器校验（no-store），撤销即时生效；但已下载到本地的 PDF 无法收回。</div>'}
        ${!sh.revoked && new Date(sh.expiresAt) > new Date() ? `<div class="doc-actions"><button class="btn-mini danger" data-revoke="${sh.id}">撤销</button></div>` : ''}
      </li>`;
    }).join('');
    $$('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
      try {
        await api('POST', `/api/shares/${b.dataset.revoke}`, { reason: 'manual' });
        window.showToast && showToast('已撤销：代理链接立即失效（签名直链的边界见说明）', 'success');
        await loadAll();
      } catch (e) { window.showToast && showToast(e.message, 'error'); }
    }));
  }

  function renderEvents() {
    $('#event-list').innerHTML = state.events.slice(0, 60).map(e =>
      `<li class="rs-item"><div class="t" style="font-size:.78rem">${esc(e.kind)}</div><div class="m"><span>${fmt(e.at)}</span>${e.reason ? `<span>${esc(e.reason)}</span>` : ''}${e.via ? `<span>${esc(e.via)}</span>` : ''}</div></li>`).join('');
  }

  // ---------------- 事件绑定 ----------------
  $('#save-key').addEventListener('click', () => {
    state.key = $('#admin-key').value.trim(); localStorage.setItem('resume_admin_key', state.key); loadAll();
  });
  $('#new-pos').addEventListener('click', async () => {
    const name = prompt('岗位名称', '新岗位 ' + new Date().toLocaleDateString('zh-CN'));
    if (!name) return;
    try {
      const { data } = await api('POST', '/api/positions', { name });
      await loadAll(); selectPosition(data.id);
    } catch (e) { window.showToast && showToast(e.message, 'error'); }
  });
  $('#reload-pos').addEventListener('click', () => state.editing && selectPosition(state.editing.id));
  $('#freeze-auto').addEventListener('click', async () => { await savePositionSafe(); await freeze('auto'); await loadAll(); });
  $('#freeze-manual').addEventListener('click', async () => { await savePositionSafe(); await freeze('manual'); await loadAll(); });
  async function savePositionSafe() { try { await savePositionSilent(); } catch (e) { if (e.status === 409) { renderEditor({ mine: state.editing.revision, server: e.data.current }); throw e; } throw e; } }
  $('#refresh-docs').addEventListener('click', loadAll);
  $$('.rs-tab').forEach(t => t.addEventListener('click', () => {
    $$('.rs-tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
    const map = { docs: 'doc-list', shares: 'share-list', events: 'event-list' };
    Object.entries(map).forEach(([k, id]) => { $('#' + id).hidden = k !== t.dataset.tab; });
  }));
  // PDF 下载改为 fetch 以拿到回执头（事件委托）
  document.addEventListener('click', async ev => {
    const a = ev.target.closest('a[data-dl]');
    if (!a) return;
    ev.preventDefault();
    await downloadPdf(a.dataset.dl);
    await loadAll();
  });

  if (state.key) loadAll();
  else { $('#pos-list').innerHTML = '<li class="rs-hint">请填写管理密钥并保存。</li>'; }
})();
