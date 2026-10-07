import fs from 'node:fs';
import path from 'node:path';
import { db, id, now } from './db.js';
import { PDF_DIR, LEVELS } from './config.js';
import { renderResume } from './render/renderer.js';
import { recheckSnapshot } from './content.js';

const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY || 2);
let running = 0;
let timer = null;

export function enqueueRender({ resumeId, resumeVersionId, idempotencyKey = null, strategy = 'auto', level = 0, fontSpecs = null, delayBeforeMs = 0 }) {
  const existing = idempotencyKey
    ? db.prepare('SELECT * FROM render_tasks WHERE idempotency_key=?').get(idempotencyKey)
    : null;
  if (existing) return existing;

  const taskId = id('task');
  db.prepare(`INSERT INTO render_tasks(id,resume_id,resume_version_id,idempotency_key,status,strategy,level,created_at,updated_at)
    VALUES(?,?,?,?, 'queued',?,?,?,?)`)
    .run(taskId, resumeId, resumeVersionId, idempotencyKey, strategy, strategy === 'manual' ? level : null, now(), now());
  return db.prepare('SELECT * FROM render_tasks WHERE id=?').get(taskId);
}

async function processTask(task) {
  running++;
  db.prepare("UPDATE render_tasks SET status='rendering', updated_at=? WHERE id=?").run(now(), task.id);
  try {
    const ver = db.prepare('SELECT * FROM resume_versions WHERE id=?').get(task.resume_version_id);
    if (!ver) throw taskErr('VERSION_MISSING', '简历版本不存在');
    const snapshot = JSON.parse(ver.snapshot);

    // 渲染前复核来源可见性（验收：排队期间作品被转私密）
    const blocked = recheckSnapshot(snapshot);
    if (blocked.length) throw Object.assign(new Error('来源条目在渲染前已变为私密/删除'), { code: 'SOURCE_NOT_VISIBLE', detail: blocked });

    // 测试钩子：由 tasks 表不可达，改用环境变量/版本扩展字段不优雅。支持通过 _test_opts 表传入。
    let fontSpecs = null, delayBeforeMs = 0;
    const opt = db.prepare('SELECT * FROM test_render_opts WHERE task_id=?').get(task.id);
    if (opt) {
      if (opt.font_specs) fontSpecs = JSON.parse(opt.font_specs);
      delayBeforeMs = opt.delay_ms || 0;
    }

    const result = await renderResume({
      snapshot,
      strategy: task.strategy,
      level: task.level ?? 0,
      fontSpecs,
      delayBeforeMs,
      visibilityGuard: recheckSnapshot, // 字体加载后、出 PDF 前再次复核（渲染中转私密）
    });

    const checksJson = JSON.stringify(result.checks || {});
    if (result.status === 'done') {
      const file = path.join(PDF_DIR, `${task.id}.pdf`);
      fs.writeFileSync(file, result.pdf);
      const receipt = {
        receipt_id: id('rcpt'),
        task_id: task.id,
        resume_id: task.resume_id,
        resume_version_id: task.resume_version_id,
        template: snapshot.template_id + '@' + snapshot.template_version,
        level: result.level,
        level_name: result.levelName,
        applied_strategy: result.appliedStrategy,
        pages: result.checks.pdfPages,
        checks: {
          overflow: result.checks.overflow.length,
          glyph_missing: result.checks.fontkitMissing.length + result.checks.glyphs.blank400.length,
          contact_fields: result.checks.contact.length,
          contact_pass: result.checks.contact.every((c) => c.ok),
          fonts_loaded: result.checks.fontsLoaded,
        },
        pdf_sha256_bytes: result.pdf.length,
        generated_at: now(),
      };
      db.prepare(`UPDATE render_tasks SET status='done', level=?, pdf_path=?, checks=?, receipt=?, error_code=NULL, error=NULL, updated_at=? WHERE id=?`)
        .run(result.level, file, checksJson, JSON.stringify(receipt), now(), task.id);
      // 版本进入“已生成”
      if (ver.status === 'draft') db.prepare("UPDATE resume_versions SET status='generated' WHERE id=?").run(ver.id);
    } else if (result.status === 'need_trim') {
      db.prepare(`UPDATE render_tasks SET status='need_trim', level=?, checks=?, error_code=?, error=?, updated_at=? WHERE id=?`)
        .run(result.level, checksJson, result.errorCode, result.error, now(), task.id);
    } else {
      db.prepare(`UPDATE render_tasks SET status='failed', level=?, checks=?, error_code=?, error=?, updated_at=? WHERE id=?`)
        .run(result.level ?? 0, checksJson, result.errorCode, result.error, now(), task.id);
    }
  } catch (e) {
    const code = e.code || 'RENDER_ERROR';
    db.prepare(`UPDATE render_tasks SET status='failed', error_code=?, error=?, checks=?, updated_at=? WHERE id=?`)
      .run(code, String(e.message || e), e.detail ? JSON.stringify({ detail: e.detail }) : null, now(), task.id);
  } finally {
    running--;
  }
}

function taskErr(code, msg) { const e = new Error(msg); e.code = code; return e; }

export function startWorker() {
  db.exec(`CREATE TABLE IF NOT EXISTS test_render_opts (
    task_id TEXT PRIMARY KEY, font_specs TEXT, delay_ms INTEGER DEFAULT 0)`);
  const tick = async () => {
    if (running >= CONCURRENCY) return;
    const task = db.prepare("SELECT * FROM render_tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
    if (task) { processTask(task); }
  };
  timer = setInterval(tick, 150);
  tick();
  return () => clearInterval(timer);
}
