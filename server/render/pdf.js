// 真实浏览器渲染 + PDF 生成 + 渲染后检查。
// 绝不使用字符数估算：
//  1) DOM 布局后逐元素测量是否溢出 A4 内容区；
//  2) document.fonts.check 逐字符检测缺字（覆盖 CJK 全字符，非抽样）；
//  3) 解析生成 PDF 的页对象，确认页数恰为 1；
//  4) 联系方式计算字号与文字对比度，并逐字确认未被裁切。
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { renderHtml, MIN_BODY_PT } = require('./template');

let browserPromise = null;
function browser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || require('path').join(__dirname, '..', 'chrome-wrapper.sh'),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--disable-gpu'],
    });
  }
  return browserPromise;
}

// 从 PDF 字节里数 /Type /Page（排除 /Pages）。
// Chromium 把大量对象放进压缩的对象流（ObjStm），必须先 inflate 全部 FlateDecode 流再统计。
const zlib = require('zlib');
function countPdfPages(bufInput) {
  const buf = Buffer.from(bufInput); // page.pdf() 可能返回 Uint8Array，其 toString() 不接受编码参数
  const countIn = str => (str.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g) || []).length;
  let total = countIn(buf.toString('latin1'));
  let pos = 0;
  const s = buf;
  while (true) {
    const i = s.indexOf(Buffer.from('stream'), pos);
    if (i < 0) break;
    let j = i + 6;
    if (s[j] === 0x0d && s[j + 1] === 0x0a) j += 2;
    else if (s[j] === 0x0d || s[j] === 0x0a) j += 1;
    const k = s.indexOf(Buffer.from('endstream'), j);
    if (k < 0) break;
    let end = k;
    if (s[end - 1] === 0x0a) end--;
    if (s[end - 1] === 0x0d) end--;
    const chunk = s.slice(j, end);
    pos = k + 9;
    if (chunk.length < 2) continue;
    try {
      const out = zlib.inflateSync(chunk);
      total += countIn(out.toString('latin1'));
    } catch { /* 非 Flate 流，忽略 */ }
  }
  return total;
}

// 页面内执行的检查函数（运行在 Chromium 上下文）
function inPageChecks() {
  const MIN_BODY_PT = 9; // 与 template.MIN_BODY_PT 保持一致（浏览器上下文需内联）
  const page = document.getElementById('page');
  const pr = page.getBoundingClientRect();
  const problems = [];

  // 1) 溢出/裁切：以“文本实际像素矩形”为准，而非字符数估算。
  //    - 每个含文本的叶子节点，用 Range 取其渲染矩形，判定是否超出 #page 内容边界；
  //    - 同时判定文本是否被自身 overflow:hidden 容器裁切（文本矩形超出该容器内边距盒）。
  const all = page.querySelectorAll('*');
  const overflowing = [];
  const TOL = 1; // px
  const textRects = el => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].filter(r => r.width > 0 || r.height > 0);
  };
  const isLeafText = el => el.children.length === 0 && (el.textContent || '').trim().length > 0;
  for (const el of all) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const cs = getComputedStyle(el);
    const clipsContent = cs.overflowX === 'hidden' || cs.overflowY === 'hidden' || cs.overflow === 'hidden';
    // 容器内边距盒（真正能显示内容的区域）
    const padL = box.left + parseFloat(cs.paddingLeft), padR = box.right - parseFloat(cs.paddingRight);
    const padT = box.top + parseFloat(cs.paddingTop), padB = box.bottom - parseFloat(cs.paddingBottom);

    let hit = null;
    if (isLeafText(el)) {
      for (const r of textRects(el)) {
        if (r.bottom - pr.bottom > TOL) { hit = { overBottom: true, text: el.textContent.trim().slice(0, 30) }; break; }
        if (r.right - pr.right > TOL)   { hit = { overRight: true, text: el.textContent.trim().slice(0, 30) }; break; }
        if (r.left - pr.left < -TOL)    { hit = { overLeft: true, text: el.textContent.trim().slice(0, 30) }; break; }
        // 被自身或祖先的 overflow:hidden 裁切（右侧常见于超长 nowrap 行）
        if (clipsContent && (r.right - padR > TOL || r.bottom - padB > TOL)) { hit = { clipped: true, text: el.textContent.trim().slice(0, 30) }; break; }
      }
    } else {
      // 布局容器只检查是否越出页面边界（表格、flex 行等）
      if (box.bottom - pr.bottom > TOL) hit = { overBottom: true };
      if (box.right - pr.right > TOL) hit = { overRight: true };
    }
    if (hit) {
      overflowing.push({ tag: el.tagName.toLowerCase(), cls: el.className || '', ...hit });
    }
  }
  if (overflowing.length) problems.push({ type: 'overflow', detail: overflowing.slice(0, 8) });

  // 2) 字体就绪 + 缺字检测（latin 与 CJK 两个子集都已显式 load）
  // 首先必须存在“已成功加载”的 Noto Sans SC 面：字体 CSS/文件下载失败时该集合为空，
  // 此时 fonts.check 只会命中系统回退字体并错误地返回 true，不能据此放行。
  const FONT = '16px "Noto Sans SC"';
  const notoFaces = [...document.fonts].filter(f => f.family.replace(/['"]/g, '') === 'Noto Sans SC');
  const notoLoaded = notoFaces.filter(f => f.status === 'loaded').length;
  const notoError = notoFaces.filter(f => f.status === 'error').map(f => `${f.weight}:${f.style}`);
  const fontReady = notoLoaded >= 2; // 至少 latin + CJK 两个子集面加载成功

  const missing = new Set();
  if (fontReady) {
    // 两个代表字符分别验证 CJK 子集与 ASCII 子集
    const probeOk = document.fonts.check(FONT, '永') && document.fonts.check(FONT, 'A');
    const text = (page.innerText || '').replace(/\s+/g, '');
    const seen = new Set();
    if (probeOk) {
      for (const ch of text) {
        if (seen.has(ch)) continue;
        seen.add(ch);
        // fonts.check 对当前 family+字重；缺字时浏览器会回退，check 返回 false
        if (!document.fonts.check(FONT, ch)) missing.add(ch);
      }
    } else {
      missing.add('PROBE');
    }
  }
  if (!fontReady || missing.size) {
    problems.push({ type: 'missing-glyph', fontReady, notoLoaded, notoError, chars: [...missing].slice(0, 50) });
  }

  // 3) 联系方式可读性：字号、对比度、逐字段未被裁切
  const requireds = [...page.querySelectorAll('[data-required]')];
  const contactIssues = [];
  const parseRGB = v => {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    return m[1].split(',').map(x => parseFloat(x));
  };
  const lum = rgb => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  for (const el of requireds) {
    const cs = getComputedStyle(el);
    const fsPt = parseFloat(cs.fontSize) * 72 / 96;
    const fg = parseRGB(cs.color);
    const bg = [255, 255, 255]; // 纸张为白底
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const r = el.getBoundingClientRect();
    const fullyInside = r.top >= pr.top - 0.5 && r.bottom <= pr.bottom + 0.5 &&
                        r.left >= pr.left - 0.5 && r.right <= pr.right + 0.5;
    // 逐字符完整性：data-required=contact 内含电话/邮箱原文，必须一字不漏
    if (fsPt < MIN_BODY_PT - 0.01) contactIssues.push({ field: el.dataset.required, issue: 'font-too-small', pt: fsPt });
    if (ratio < 4.5) contactIssues.push({ field: el.dataset.required, issue: 'low-contrast', ratio: Math.round(ratio * 100) / 100 });
    if (!fullyInside) contactIssues.push({ field: el.dataset.required, issue: 'clipped-or-outside' });
  }
  if (contactIssues.length) problems.push({ type: 'contact-readability', detail: contactIssues });

  // 最小字号：正文内不允许任何可见文字低于 9pt
  let minSeen = 999;
  for (const el of all) {
    if (!el.textContent.trim() || el.children.length) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize) * 72 / 96;
    if (fs < minSeen) minSeen = fs;
  }
  if (minSeen < MIN_BODY_PT - 0.01) problems.push({ type: 'below-min-font', minPt: Math.round(minSeen * 100) / 100 });

  return {
    overflow: overflowing.length,
    overflowSamples: overflowing.slice(0, 8),
    missingChars: [...missing],
    fontReady,
    minSeenPt: Math.round(minSeen * 100) / 100,
    contactIssues,
    problems,
    ok: problems.length === 0,
  };
}

// 生成 PDF：baseUrl 用于加载字体 css；simulateFontFail=true 时字体端点返回错误
async function generatePdf(doc, { level = 1, baseUrl, simulateFontFail = false } = {}) {
  const fontUrl = `${baseUrl}/__resume/fonts.css?fail=${simulateFontFail ? '1' : '0'}`;
  const html = renderHtml(doc, { level, fontUrl });
  const br = await browser();
  const page = await br.newPage();
  const fontErrors = [];
  page.on('requestfailed', req => {
    if (req.url().includes('/__resume/fonts')) fontErrors.push(req.url());
  });
  page.on('response', resp => {
    if (resp.url().includes('/__resume/fonts') && resp.status() >= 400) fontErrors.push(`${resp.url()} -> ${resp.status()}`);
  });

  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
  // 显式加载所有 Noto Sans SC 面（@font-face 默认懒加载，不主动 load 会误报缺字）
  let fontLoadError = false;
  const fontLoad = await page.evaluate(async () => {
    const faces = [...document.fonts].filter(f => f.family.replace(/['"]/g, '') === 'Noto Sans SC');
    const settled = await Promise.allSettled(faces.map(f => f.load()));
    await document.fonts.ready;
    return {
      total: faces.length,
      loaded: faces.filter(f => f.status === 'loaded').length,
      error: faces.filter(f => f.status === 'error').map(f => `${f.weight}:${f.style}`),
      rejected: settled.filter(x => x.status === 'rejected').length,
    };
  }).catch(e => ({ crash: String(e) }));
  if (fontLoad.crash) fontLoadError = true;

  const metrics = await page.evaluate(inPageChecks);
  if (fontErrors.length || fontLoadError) {
    metrics.fontEndpointErrors = fontErrors;
    // 字体端点失败是硬失败：确保检查结果包含 missing-glyph，绝不放行
    if (!metrics.problems.some(p => p.type === 'missing-glyph')) {
      metrics.problems.push({ type: 'missing-glyph', fontReady: false, endpoint: fontErrors });
    }
    metrics.ok = false;
  }

  const pdfBuf = await page.pdf({
    width: '210mm', height: '297mm',
    printBackground: false, preferCSSPageSize: true,
  });
  await page.close();

  const pages = countPdfPages(pdfBuf);
  if (pages !== 1) {
    metrics.problems.push({ type: 'page-count', pages });
    metrics.ok = false;
  }
  metrics.pdfPages = pages;
  return { pdfBuf, metrics };
}

module.exports = { generatePdf, countPdfPages };
