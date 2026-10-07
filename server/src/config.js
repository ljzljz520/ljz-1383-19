import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, '..');
export const SITE_ROOT = path.resolve(SERVER_ROOT, '..');
export const DATA_DIR = path.join(SERVER_ROOT, 'data');
export const PDF_DIR = path.join(SERVER_ROOT, 'pdfs');
export const FONT_DIR = path.join(SERVER_ROOT, 'assets', 'fonts');
export const DB_PATH = path.join(DATA_DIR, 'app.db');

for (const d of [DATA_DIR, PDF_DIR]) fs.mkdirSync(d, { recursive: true });

export const PORT = Number(process.env.PORT || 4178);
export const OWNER_TOKEN = process.env.OWNER_TOKEN || 'dev-owner-token-2026';

// 签名 URL 的服务器密钥：持久化到 data/secret，重启后旧签名仍可验；
// 轮换密钥会让所有离线签名链接立即失效（这是紧急下线手段）。
function loadOrCreateSecret() {
  const p = path.join(DATA_DIR, 'secret.key');
  try { return fs.readFileSync(p, 'utf8').trim(); }
  catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(p, s, { mode: 0o600 });
    return s;
  }
}
export const SERVER_SECRET = process.env.SERVER_SECRET || loadOrCreateSecret();

// 字体远程下载超时（“字体下载失败”场景）
export const FONT_FETCH_TIMEOUT_MS = Number(process.env.FONT_FETCH_TIMEOUT_MS || 8000);

// 渲染工作流：冻结的内容模板版本（API 冻结内容与模板）
export const TEMPLATE_ID = 'onepage-v1';

// 一页 A4 @96dpi
export const PAGE = {
  widthPx: 794,
  heightPx: 1123, // 297mm
};

// —— 硬性渲染约束：最小字号 / 最小留白 / 不可裁切字段 ——
// 自动压缩版式只允许在不低于这些下限的范围内调整排版参数，
// 不允许删除、截断用户选定的任何字段或条目。
export const LIMITS = Object.freeze({
  nameMinPt: 15,        // 姓名
  jobTitleMinPt: 10.5,  // 目标岗位
  contactMinPt: 9,      // 邮箱 / 电话等联系方式
  headingMinPt: 10.5,   // 区块标题（教育/技能/项目）
  bodyMinPt: 9,         // 正文 / 项目条目
  lineHeightMin: 1.28,
  marginMmMin: 9,
  sectionGapPtMin: 4,
  contactContrastMin: 4.5, // WCAG AA 正文对比比
  // 不可裁切字段：压缩与溢出处理都不得删除、缩写或截断
  nonClippable: Object.freeze([
    'contact.name',
    'contact.email',
    'contact.phone',
    'job_title',
    'company',
  ]),
});

// 自动压缩的四级版式，全部不低于 LIMITS。
export const LEVELS = Object.freeze([
  { level: 0, name: '22pt/11pt 舒适',    namePt: 22, jobPt: 13, contactPt: 10, headingPt: 13, bodyPt: 11, lh: 1.45, marginMm: 14, gapPt: 10 },
  { level: 1, name: '19pt/10.5pt 紧凑',  namePt: 19, jobPt: 12, contactPt: 9.5, headingPt: 12, bodyPt: 10.5, lh: 1.38, marginMm: 12, gapPt: 7 },
  { level: 2, name: '17pt/10pt',         namePt: 17, jobPt: 11, contactPt: 9, headingPt: 11, bodyPt: 10, lh: 1.32, marginMm: 10.5, gapPt: 6 },
  { level: 3, name: '15pt/9pt 下限版',   namePt: 15, jobPt: 10.5, contactPt: 9, headingPt: 10.5, bodyPt: 9, lh: 1.28, marginMm: 9, gapPt: 4 },
]);
