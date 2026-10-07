// 根据“已冻结内容”渲染一页 A4 简历 HTML。
// 设计约束：
//  - 固定 A4 内容区，字号由 compaction 决定；
//  - 硬性最小字号 9pt（姓名/标题更大）；
//  - 不可裁切字段（姓名、电话、邮箱）始终完整保留，不允许截断或省略；
//  - 字体使用 Noto Sans SC（服务端注入），渲染前会逐字符检查缺字。

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const LEVELS = {
  // level: [正文pt, 标题pt, 间距倍率, 行距]
  1: { body: 10.5, h: 13, name: 22, gap: 1.0, lh: 1.5 },
  2: { body: 10,   h: 12, name: 20, gap: 0.78, lh: 1.4 },
  3: { body: 9,    h: 11, name: 18, gap: 0.6,  lh: 1.3 },
};

const FONT_CSS_URL = '/__resume/fonts.css';

function renderHtml(doc, opts = {}) {
  const level = LEVELS[opts.level] || LEVELS[1];
  const c = doc.content;
  const contact = c.contact || {};
  const fontUrl = opts.fontUrl || FONT_CSS_URL;

  const eduRows = (c.educations || []).map(e => `
    <tr>
      <td class="period">${esc(e.period)}</td>
      <td><strong>${esc(e.school)}</strong> · ${esc(e.degree)} · ${esc(e.major)}</td>
    </tr>`).join('');

  const skillGroups = (c.skills || []).map(s => `
    <div class="skill"><span class="skill-g">${esc(s.group)}</span><span class="skill-i">${esc(s.items)}</span></div>`).join('');

  const projects = (c.projects || []).map(p => `
    <div class="proj">
      <div class="proj-head"><strong>${esc(p.title)}</strong><span class="proj-meta">${esc(p.role)} · ${esc(p.period)}</span></div>
      <ul>${(p.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul>
    </div>`).join('');

  // 联系方式：不可裁切字段，单行 nowrap + 高对比；检查器会验证其完整可见
  const contactLine = [contact.phone, contact.email, contact.site].filter(Boolean).map(esc).join('　｜　');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${esc(fontUrl)}">
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html,body { margin:0; padding:0; background:#fff; }
  :root {
    --ink:#101828; --sub:#475467; --line:#d0d5dd; --accent:#1d4ed8;
  }
  body { font-family:'Noto Sans SC', sans-serif; color:var(--ink); -webkit-font-smoothing:antialiased; }
  #page {
    width: 210mm; height: 297mm;
    padding: 13mm 14mm;
    font-size: ${level.body}pt; line-height: ${level.lh};
    overflow: hidden;
  }
  .name { font-size: ${level.name}pt; font-weight:700; letter-spacing:.5px; margin:0; }
  .target { color:var(--accent); font-weight:600; margin:1mm 0 2mm; font-size:${level.body + 0.5}pt; }
  .contact {
    color:#1d2939; font-size:${level.body}pt; font-weight:500;
    white-space:nowrap; overflow:visible; /* 不允许省略号裁切 */
    border-bottom:1.4pt solid var(--ink); padding-bottom:2.4mm; margin-bottom:${3.2 * level.gap}mm;
  }
  h2 { font-size:${level.h}pt; margin:${3.4 * level.gap}mm 0 ${1.8 * level.gap}mm; padding-left:2.4mm;
       border-left:3pt solid var(--accent); }
  table { width:100%; border-collapse:collapse; }
  td { padding:${0.9 * level.gap}mm 0; vertical-align:top; }
  td.period { width:42mm; color:var(--sub); white-space:nowrap; }
  .skill { margin:${0.8 * level.gap}mm 0; }
  .skill-g { display:inline-block; min-width:26mm; font-weight:600; color:var(--accent); }
  .proj { margin-bottom:${2 * level.gap}mm; }
  .proj-head { display:flex; justify-content:space-between; gap:6mm; }
  .proj-meta { color:var(--sub); white-space:nowrap; font-size:${Math.max(9, level.body - 0.5)}pt; }
  ul { margin:${0.8 * level.gap}mm 0 0; padding-left:5mm; }
  li { margin:${0.4 * level.gap}mm 0; }
</style></head>
<body><div id="page">
  <p class="name" data-required="name">${esc(contact.name)}</p>
  <p class="target">${esc(c.target || '')}</p>
  <div class="contact" data-required="contact">${contactLine}</div>
  <h2>教育经历</h2>
  <table>${eduRows}</table>
  <h2>专业技能</h2>
  ${skillGroups}
  <h2>项目经验</h2>
  ${projects}
</div></body></html>`;
}

module.exports = { renderHtml, LEVELS, MIN_BODY_PT: 9 };
