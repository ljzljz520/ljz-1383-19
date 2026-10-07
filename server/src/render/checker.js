// 全部检查都在真实渲染之后、于浏览器内执行；返回结构化报告。
function checkInBrowser(contentW, contentH, limitsPt, contact) {
  const TOL = 1.5;
  const report = { overflow: [], glyphs: { blank400: [], blank700: [] }, contact: [], fontsLoaded: false };

  // ---------- 1) 溢出检查：逐元素边界 + 内容容器总高（不是估算字符数） ----------
  const page = document.getElementById('page');
  const overflows = [];
  if (page.scrollWidth > contentW + TOL) overflows.push({ what: 'page-scrollWidth', value: page.scrollWidth, max: contentW });
  if (page.scrollHeight > contentH + TOL) overflows.push({ what: 'page-scrollHeight', value: page.scrollHeight, max: contentH });
  for (const el of document.querySelectorAll('#page *')) {
    const r = el.getBoundingClientRect();
    const base = page.getBoundingClientRect();
    const x = r.left - base.left, y = r.top - base.top;
    if (r.width === 0) continue;
    if (x + r.width > contentW + TOL) overflows.push({ what: 'right-overflow', el: el.className || el.tagName, value: +(x + r.width).toFixed(1), max: contentW });
    if (y + r.height > contentH + TOL) overflows.push({ what: 'bottom-overflow', el: el.className || el.tagName, value: +(y + r.height).toFixed(1), max: contentH });
    if (el.scrollWidth > el.clientWidth + TOL && getComputedStyle(el).whiteSpace !== 'nowrap') {
      overflows.push({ what: 'clipped-x', el: el.className || el.tagName, value: el.scrollWidth, max: el.clientWidth });
    }
  }
  report.overflow = overflows;

  // ---------- 2) 字体缺字：逐字符真实光栅化，alpha 全 0 即 .notdef（缺字/豆腐块） ----------
  const cv = document.createElement('canvas');
  cv.width = 48; cv.height = 48;
  const ctx = cv.getContext('2d');
  function blankFor(ch, weight) {
    ctx.clearRect(0, 0, 48, 48);
    ctx.font = `${weight} 32px 'Noto Sans SC', monospace`;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    ctx.fillText(ch, 4, 4);
    const d = ctx.getImageData(0, 0, 48, 48).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 10) ink++;
    return ink === 0;
  }
  const chars = new Set();
  for (const n of document.querySelectorAll('#page *')) {
    for (const t of n.childNodes) if (t.nodeType === 3) for (const ch of t.nodeValue) if (ch.trim()) chars.add(ch);
  }
  for (const ch of chars) {
    if (blankFor(ch, 400)) report.glyphs.blank400.push(ch);
    if (blankFor(ch, 700)) report.glyphs.blank700.push(ch);
  }

  // ---------- 3) 联系方式可读性：最小字号 / 对比比 / 未被裁切 / mailto/tel 机读一致 ----------
  function lum(rgb) {
    const a = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrast(fg) { const l1 = lum(fg), l2 = lum([255, 255, 255]); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  const PX2PT = 72 / 96;
  const minMap = {
    'contact.name': limitsPt.nameMinPt, 'contact.email': limitsPt.contactMinPt,
    'contact.phone': limitsPt.contactMinPt, 'contact.website': limitsPt.contactMinPt,
    'contact.location': limitsPt.contactMinPt, job_title: limitsPt.jobTitleMinPt, company: limitsPt.jobTitleMinPt,
  };
  const seen = new Set();
  for (const el of document.querySelectorAll('[data-field]')) {
    const field = el.getAttribute('data-field');
    if (seen.has(field)) continue;
    seen.add(field);
    const cs = getComputedStyle(el);
    const pt = parseFloat(cs.fontSize) * PX2PT;
    const min = minMap[field] ?? limitsPt.bodyMinPt;
    const r = el.getBoundingClientRect();
    const b = page.getBoundingClientRect();
    const x = r.left - b.left, y = r.top - b.top;
    const problems = [];
    if (pt < min - 0.05) problems.push({ type: 'font-size', value: +pt.toFixed(2), min });
    const m = cs.color.match(/[\d.]+/g).map(Number);
    const fg = m.length >= 3 ? m.slice(0, 3) : [0, 0, 0];
    const ratio = contrast(fg);
    if (ratio < limitsPt.contactContrastMin) problems.push({ type: 'contrast', value: +ratio.toFixed(2), min: limitsPt.contactContrastMin });
    if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0 || cs.display === 'none') problems.push({ type: 'not-visible' });
    if (x < -TOL || y < -TOL || x + r.width > contentW + TOL || y + r.height > contentH + TOL) problems.push({ type: 'outside-page' });
    if (el.scrollWidth > el.clientWidth + TOL) problems.push({ type: 'truncated' });
    if (field === 'contact.email' && contact.email) {
      if (el.tagName !== 'A' || !el.getAttribute('href').startsWith('mailto:')) problems.push({ type: 'mailto-missing' });
      if (el.textContent.trim() !== contact.email.trim()) problems.push({ type: 'email-text-mismatch' });
    }
    if (field === 'contact.phone' && contact.phone) {
      if (el.tagName !== 'A' || !el.getAttribute('href').startsWith('tel:')) problems.push({ type: 'tel-missing' });
      if (el.textContent.replace(/\s/g, '') !== contact.phone.replace(/\s/g, '')) problems.push({ type: 'phone-text-mismatch' });
    }
    report.contact.push({ field, ok: problems.length === 0, fontPt: +pt.toFixed(2), contrast: +ratio.toFixed(2), problems });
  }
  for (const key of ['contact.name', 'contact.email', 'contact.phone']) {
    const val = key === 'contact.name' ? contact.name : contact[key.split('.')[1]];
    if (val && !seen.has(key)) report.contact.push({ field: key, ok: false, problems: [{ type: 'not-rendered' }] });
  }
  report.fontsLoaded = document.fonts.check('16px "Noto Sans SC"') && document.fonts.check('700 16px "Noto Sans SC"');
  report.pass = report.overflow.length === 0
    && report.glyphs.blank400.length === 0 && report.glyphs.blank700.length === 0
    && report.contact.every((c) => c.ok) && report.fontsLoaded;
  return report;
}

export function buildCheckScript(params) {
  return { fn: `(${checkInBrowser.toString()})`, args: [params.contentW, params.contentH, params.limitsPt, params.contact] };
}
