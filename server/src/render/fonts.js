import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as fontkitNS from 'fontkit';
const fontkit = fontkitNS.default || fontkitNS;
import { FONT_DIR, FONT_FETCH_TIMEOUT_MS } from '../config.js';

// 本地“打包字体”（渲染随产品交付，不依赖外网），保证常规中/英简历不缺字。
const BUNDLED = {
  regular: { family: 'Noto Sans SC', weight: 400, file: 'NotoSansCJKsc-Regular.otf' },
  bold:    { family: 'Noto Sans SC', weight: 700, file: 'NotoSansCJKsc-Bold.otf' },
};

const fontCache = new Map(); // key -> {bytes, font, family, weight}

export class FontLoadError extends Error {
  constructor(spec, cause) {
    super(`字体下载失败: ${spec.url || spec.file}`);
    this.code = 'FONT_LOAD_FAILED';
    this.spec = spec;
    if (cause) this.cause = cause;
  }
}

function readBundled(file) {
  const p = path.join(FONT_DIR, file);
  try { return fs.readFileSync(p); }
  catch (e) { throw new FontLoadError({ file }, e); }
}

async function fetchWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new FontLoadError({ url }, e);
  } finally { clearTimeout(t); }
}

// spec: {kind:'bundled'|'url', weight:400|700, url?, file?}
export async function loadFont(spec) {
  const key = spec.kind === 'bundled'
    ? `bundled:${spec.file}`
    : `url:${spec.url}#${spec.weight}`;
  if (fontCache.has(key)) return fontCache.get(key);

  const meta = spec.weight === 700 ? BUNDLED.bold : BUNDLED.regular;
  const bytes = spec.kind === 'bundled'
    ? readBundled(spec.file || meta.file)
    : await fetchWithTimeout(spec.url, FONT_FETCH_TIMEOUT_MS);

  let font;
  try { font = fontkit.create(bytes); }
  catch (e) { throw new FontLoadError(spec, new Error('字体文件无法解析（损坏或非字体）')); }

  const entry = {
    bytes,
    font,
    family: meta.family,
    weight: spec.weight || meta.weight,
    checksum: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
  };
  fontCache.set(key, entry);
  return entry;
}

// 默认渲染使用的两份打包字体
export function defaultFontSpecs() {
  return [
    { kind: 'bundled', weight: 400, file: BUNDLED.regular.file },
    { kind: 'bundled', weight: 700, file: BUNDLED.bold.file },
  ];
}

// 确定性缺字检测：任何正文里出现的码点，必须在对应字重字体 cmap 中存在。
// 不能只估算字符数——这里逐码点核对字体覆盖（.notdef 即缺字）。
export function findMissingGlyphs(text, fontEntry) {
  const missing = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x20) continue;
    if (cp === 0xa0) continue;
    if (!fontEntry.font.hasGlyphForCodePoint(cp)) missing.add(ch);
  }
  return [...missing];
}

export function toDataUrl(bytes) {
  return 'data:font/otf;base64,' + bytes.toString('base64');
}
