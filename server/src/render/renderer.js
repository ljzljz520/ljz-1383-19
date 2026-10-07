import { chromium } from 'playwright';
import { LEVELS, LIMITS, PAGE } from '../config.js';
import { loadFont, defaultFontSpecs, findMissingGlyphs } from './fonts.js';
import { renderResumeHTML } from './template.js';
import { snapshotText } from '../content.js';
import { buildCheckScript } from './checker.js';

let browserPromise = null;
async function browser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  return browserPromise;
}
export async function closeBrowser() {
  if (browserPromise) { await (await browserPromise).close(); browserPromise = null; }
}

function mmToPx(mm) { return mm / 25.4 * 96; }

export function countPdfPages(buf) {
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

function trimSuggestions(report) {
  const tips = [];
  const byKind = {};
  for (const o of report.overflow || []) {
    if (o.el) byKind[o.el] = (byKind[o.el] || 0) + 1;
  }
  if (Object.keys(byKind).length) tips.push('项目/技能条目在最低字号下仍越界：请删减部分条目或精简描述文字（不允许系统裁切）');
  if ((report.overflow || []).some((o) => o.what === 'page-scrollHeight')) tips.push('内容总高度超过一页：建议删减 1–2 个项目描述，或将长描述压缩为一行要点');
  if ((report.overflow || []).some((o) => o.what === 'right-overflow')) tips.push('存在横向溢出：检查超长链接/名称，建议缩短网站地址');
  if (!tips.length) tips.push('内容超出一页，请删减条目（姓名/联系方式/目标岗位不会被删除）');
  return tips;
}

// 渲染一次指定 level；返回 {ok, report, pdf?, pdfPages}
async function attempt({ snapshot, level, fonts, fontMissing }) {
  const b = await browser();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  try {
    const marginPx = mmToPx(level.marginMm);
    const contentW = Math.round((PAGE.widthPx - 2 * marginPx) * 10) / 10;
    const contentH = Math.round((PAGE.heightPx - 2 * marginPx) * 10) / 10;
    const html = renderResumeHTML(snapshot, level, fonts);
    await page.setViewportSize({ width: Math.ceil(contentW), height: Math.ceil(contentH) });
    await page.emulateMedia({ media: 'print' });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(120);

    const check = buildCheckScript({ contentW, contentH, marginPx, limitsPt: LIMITS, contact: snapshot.contact });
    const payload = { fn: check.fn, w: contentW, h: contentH, limits: LIMITS, contact: snapshot.contact };
    const report = await page.evaluate((pl) => { const f = new Function('return ' + pl.fn)(); return f(pl.w, pl.h, pl.limits, pl.contact); }, payload);
    report.contentW = contentW; report.contentH = contentH;
    report.fontkitMissing = fontMissing;

    // 缺字（fontkit 权威 + 浏览器光栅化双证据之一即可判定失败）
    if (fontMissing.length || report.glyphs.blank400.length || report.glyphs.blank700.length) {
      return { ok: false, fatal: 'GLYPH_MISSING', report };
    }
    const badContact = (report.contact || []).filter((c) => !c.ok);
    if (badContact.length) return { ok: false, fatal: 'CONTACT_UNREADABLE', report };

    // 先看 DOM 溢出，再生成真实 PDF 数页（防止 DOM 测量遗漏）
    if (report.overflow.length) return { ok: false, fatal: null, report };

    const pdf = await page.pdf({
      width: '210mm', height: '297mm',
      margin: { top: level.marginMm + 'mm', bottom: level.marginMm + 'mm', left: level.marginMm + 'mm', right: level.marginMm + 'mm' },
      printBackground: true, preferCSSPageSize: false,
    });
    const pdfPages = countPdfPages(pdf);
    report.pdfPages = pdfPages;
    if (pdfPages !== 1) { report.overflow.push({ what: 'pdf-pages', value: pdfPages, max: 1 }); return { ok: false, fatal: null, report }; }
    return { ok: true, report, pdf };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// 主入口。strategy: 'auto' 时依次尝试 0..3 级；'manual' 只用指定 level。
// fontSpecs 可注入“坏字体”地址用于验收。
export async function renderResume({ snapshot, strategy = 'auto', level = 0, fontSpecs = null, delayBeforeMs = 0, visibilityGuard = null }) {
  const specs = fontSpecs || defaultFontSpecs();
  const fonts = [];
  for (const spec of specs) fonts.push(await loadFont(spec)); // 任一下载失败 -> FONT_LOAD_FAILED

  const text = snapshotText(snapshot);
  const missingSet = new Set();
  for (const f of fonts) for (const ch of findMissingGlyphs(text, f)) missingSet.add(ch);
  const fontMissing = [...missingSet];

  // 延迟（验收钩子）之后、真正出 PDF 之前再复核一次来源可见性
  if (delayBeforeMs) await new Promise((r) => setTimeout(r, delayBeforeMs));
  if (visibilityGuard) {
    const blocked = visibilityGuard(snapshot);
    if (blocked && blocked.length) throw Object.assign(new Error('来源条目在渲染前已变为私密/删除'), { code: 'SOURCE_NOT_VISIBLE', detail: blocked });
  }

  if (strategy === 'manual') {
    const r = await attempt({ snapshot, level: LEVELS[level] || LEVELS[0], fonts, fontMissing });
    if (r.ok) return finishOk(r, level);
    return r.fatal === 'GLYPH_MISSING' ? fail('GLYPH_MISSING', '字体缺字（含 .notdef），无法生成合格 PDF', r.report, level)
      : r.fatal === 'CONTACT_UNREADABLE' ? fail('CONTACT_UNREADABLE', '联系方式未通过可读性检查', r.report, level)
      : fail('OVERFLOW_MANUAL', '一页内放不下（手动模式不自动压缩）', r.report, level);
  }

  let last = null;
  for (let i = 0; i < LEVELS.length; i++) {
    const r = await attempt({ snapshot, level: LEVELS[i], fonts, fontMissing });
    last = { r, i };
    if (r.fatal === 'GLYPH_MISSING') return fail('GLYPH_MISSING', '字体缺字（含 .notdef），请替换字符或补字库', r.report, i);
    if (r.fatal === 'CONTACT_UNREADABLE') return fail('CONTACT_UNREADABLE', '联系方式字号/对比比/机读性不达标', r.report, i);
    if (r.ok) {
      return {
        status: 'done', level: i, levelName: LEVELS[i].name, pdf: r.pdf,
        checks: r.report, appliedStrategy: i === 0 ? 'auto:none' : `auto:compress:L${i}`,
      };
    }
  }
  // 已到最小字号/留白下限仍溢出 → 不裁切、不删内容，提示用户删减
  const rep = last.r.report;
  rep.trimSuggestions = trimSuggestions(rep);
  return {
    status: 'need_trim', level: last.i, levelName: LEVELS[last.i].name,
    checks: rep, appliedStrategy: `auto:compress:L${last.i}`,
    errorCode: 'NEEDS_TRIM',
    error: '已应用最小字号与最小留白版式仍超出一页。为遵守“不可裁切字段”约束，系统不会截断或删除任何条目，请按建议删减后重新生成。',
  };
}

function finishOk(r, level) {
  return { status: 'done', level, levelName: LEVELS[level].name, pdf: r.pdf, checks: r.report, appliedStrategy: 'manual' };
}
function fail(code, error, report, level) {
  return { status: 'failed', level, errorCode: code, error, checks: report, appliedStrategy: `level:${level}` };
}
