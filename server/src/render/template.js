import { toDataUrl } from './fonts.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const KIND_LABEL = { education: '教育经历', skill: '技能', project: '项目经历' };
const KIND_ORDER = { education: 0, skill: 1, project: 2 };

// 唯一被冻结的一页模板。排版尺寸全部由 level 注入（自动压缩只改这些数值）。
export function renderResumeHTML(snapshot, level, fonts) {
  const c = snapshot.contact || {};
  const groups = ['education', 'skill', 'project']
    .map((kind) => ({ kind, items: (snapshot.items || []).filter((i) => i.kind === kind) }))
    .filter((g) => g.items.length);

  const fontFace = fonts.map((f) => `
    @font-face {
      font-family: '${esc(f.family)}';
      font-weight: ${f.weight};
      font-display: block;
      src: url(${toDataUrl(f.bytes)}) format('opentype');
    }`).join('\n');

  const sections = groups.map((g) => `
    <section class="block" data-kind="${g.kind}">
      <h2 class="heading">${esc(KIND_LABEL[g.kind])}</h2>
      ${g.kind === 'skill'
        ? `<ul class="skills">${g.items.map((i) => `<li class="skill-item" data-source="${esc(i.source_id)}">${esc(i.title)}<span class="muted"> · ${esc(i.body)}</span></li>`).join('')}</ul>`
        : `<ul class="entries">${g.items.map((i) => `
            <li class="entry" data-source="${esc(i.source_id)}">
              <div class="entry-title">${esc(i.title)}</div>
              <div class="entry-body">${esc(i.body)}</div>
              ${i.tags && i.tags.length ? `<div class="tags">${i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
            </li>`).join('')}</ul>`
      }
    </section>`).join('\n');

  const contactBits = [];
  if (c.email) contactBits.push(`<a class="contact-item" data-field="contact.email" href="mailto:${encodeURIComponent(c.email)}">${esc(c.email)}</a>`);
  if (c.phone) contactBits.push(`<a class="contact-item" data-field="contact.phone" href="tel:${esc(c.phone.replace(/\s+/g, ''))}">${esc(c.phone)}</a>`);
  if (c.website) contactBits.push(`<a class="contact-item" data-field="contact.website" href="${esc(/^https?:/.test(c.website) ? c.website : 'https://' + c.website)}">${esc(c.website.replace(/^https?:\/\//, ''))}</a>`);
  if (c.location) contactBits.push(`<span class="contact-item" data-field="contact.location">${esc(c.location)}</span>`);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(c.name || '简历')} - ${esc(snapshot.job_title)}</title>
<style>
${fontFace}
:root{
  --name:${level.namePt}pt; --job:${level.jobPt}pt; --contact:${level.contactPt}pt;
  --heading:${level.headingPt}pt; --body:${level.bodyPt}pt;
  --lh:${level.lh}; --gap:${level.gapPt}pt; --margin:${level.marginMm}mm;
  --ink:#14181f; --muted:#4a5260; --line:#c9d0da; --accent:#1f5fa8;
}
@page { size: A4; margin: var(--margin); }
* { box-sizing: border-box; }
html,body { margin:0; padding:0; }
body{
  font-family:'Noto Sans SC', sans-serif;
  color:var(--ink);
  font-size:var(--body);
  line-height:var(--lh);
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
.page{ width:100%; }
header.nameplate{ border-bottom:2px solid var(--ink); padding-bottom:6pt; margin-bottom:var(--gap); }
.name{ font-size:var(--name); font-weight:700; line-height:1.15; letter-spacing:0.5pt; }
.job-title{ font-size:var(--job); font-weight:700; color:var(--accent); margin-top:2pt; }
.contacts{ margin-top:4pt; font-size:var(--contact); line-height:1.35; color:var(--ink); }
.contact-item{ display:inline-block; margin-right:10pt; color:var(--ink); text-decoration:none; }
a.contact-item[href^="mailto"],a.contact-item[href^="tel"]{ text-decoration:underline; text-underline-offset:2px; }
.block{ margin-top:var(--gap); }
.heading{ font-size:var(--heading); font-weight:700; margin:0 0 3pt; padding-left:6pt; border-left:3pt solid var(--accent); }
ul{ margin:0; padding-left:14pt; }
li{ margin-bottom:2.5pt; }
.entry-title{ font-weight:700; }
.entry-body,.muted{ color:var(--ink); }
.skills li{ margin-bottom:1.5pt; }
.tags{ margin-top:1pt; }
.tag{ display:inline-block; font-size:calc(var(--body) - 0.5pt); border:0.6pt solid var(--line); border-radius:8pt; padding:0 6pt; margin:0 3pt 2pt 0; color:var(--muted); }
</style>
</head>
<body>
<div class="page" id="page">
  <header class="nameplate">
    <div class="name" data-field="contact.name">${esc(c.name || '')}</div>
    <div class="job-title" data-field="job_title">${esc(snapshot.job_title)}${snapshot.company ? ` · <span data-field="company">${esc(snapshot.company)}</span>` : ''}</div>
    <div class="contacts">${contactBits.join('')}</div>
  </header>
  ${sections}
</div>
</body>
</html>`;
}
