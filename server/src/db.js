import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { DB_PATH } from './config.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function id(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('base64url');
}
export const now = () => new Date().toISOString();

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('education','skill','project')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  visible INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resumes (
  id TEXT PRIMARY KEY,
  job_title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '{}',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resume_versions (
  id TEXT PRIMARY KEY,
  resume_id TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  job_title TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '{}',
  source_ids TEXT NOT NULL DEFAULT '[]',
  snapshot TEXT NOT NULL,            -- 冻结的内容（含固定来源版本）
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','generated','shared')),
  created_at TEXT NOT NULL,
  UNIQUE(resume_id, version)
);
CREATE TABLE IF NOT EXISTS render_tasks (
  id TEXT PRIMARY KEY,
  resume_id TEXT NOT NULL,
  resume_version_id TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','rendering','done','need_trim','failed')),
  strategy TEXT DEFAULT 'auto',     -- auto | manual
  level INTEGER,
  pdf_path TEXT,
  checks TEXT,
  error_code TEXT,
  error TEXT,
  receipt TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(idempotency_key)
);
CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  resume_id TEXT NOT NULL,
  resume_version_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('proxy','signed')),
  revoked INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS share_access (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  result TEXT NOT NULL,
  ip TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS download_tickets (
  ticket TEXT PRIMARY KEY,
  resume_version_id TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);
`);

// —— 固定来源种子数据（与静态站作品对应；“作品转私密”由 visible 控制）——
const seed = [
  ['edu_1', 'education', '华南理工大学 · 数字媒体技术（本科）', '2017–2021，GPA 3.7/4.0，主修交互设计、Web 工程、人机交互。', '["学位","本科"]'],
  ['edu_2', 'education', 'UI/UX 专项进修', '2022，交互原型与可用性测试方向，完成 6 个实战课题。', '["进修"]'],
  ['skl_1', 'skill', '前端工程', 'HTML5 / CSS3 / 原生 JavaScript / 响应式布局 / 可访问性', '["HTML","CSS","JavaScript","a11y"]'],
  ['skl_2', 'skill', '视觉与交互', 'Glassmorphism 设计、设计系统、原型、可用性走查', '["UI","UX","原型"]'],
  ['skl_3', 'skill', '后端与自动化', 'Node.js / SQLite / Headless Chromium / PDF 渲染管线', '["Node","SQLite","自动化"]'],
  ['prj_1', 'project', 'Neo-Finance 金融应用重设计', '主导信息架构与视觉系统，重构关键转账流程，任务完成率提升 24%。', '["UI","金融"]'],
  ['prj_2', 'project', '太阳能监测看板', '设计数据密度与告警层级，搭建实时图表与响应式看板。', '["数据可视化","IoT"]'],
  ['prj_3', 'project', '个人创意主页', '三级页面架构、毛玻璃视觉、原生 JS 组件与表单校验。', '["个人站","前端"]'],
];
const upsertSrc = db.prepare(`INSERT INTO sources(id,kind,title,body,tags,visible,updated_at)
  VALUES(@id,@kind,@title,@body,@tags,1,@ts)
  ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tags=excluded.tags, updated_at=excluded.updated_at`);
const ts = now();
for (const [id, kind, title, body, tags] of seed) {
  upsertSrc.run({ id, kind, title, body, tags, ts });
}
