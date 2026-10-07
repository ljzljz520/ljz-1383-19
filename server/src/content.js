import { db, id, now } from './db.js';
import { TEMPLATE_ID } from './config.js';

export const TEMPLATE_VERSION = '1.0.0'; // 模板被 API 冻结，历史版本不跟随模板改动

export class SourceVisibilityError extends Error {
  constructor(sources) {
    super('存在不可用（私密/已删除）的来源条目');
    this.code = 'SOURCE_NOT_VISIBLE';
    this.sources = sources;
  }
}

export function getSource(sid) {
  return db.prepare('SELECT * FROM sources WHERE id=?').get(sid) || null;
}

// 按选定 source_ids 冻结内容。任一来源不可见即失败（验收：渲染中作品转私密）。
// 历史简历永远以冻结快照渲染，不会自动套用最新项目。
export function buildSnapshot({ sourceIds, jobTitle, company, contact }) {
  const blocked = [];
  const items = [];
  for (const sid of [...new Set(sourceIds || [])]) {
    const s = getSource(sid);
    if (!s || !s.visible) {
      blocked.push({ id: sid, reason: !s ? 'deleted' : 'private' });
      continue;
    }
    items.push({
      source_id: s.id,
      kind: s.kind,
      title: s.title,
      body: s.body,
      tags: JSON.parse(s.tags || '[]'),
      frozen_at: now(),
    });
  }
  if (blocked.length) throw new SourceVisibilityError(blocked);

  return {
    template_id: TEMPLATE_ID,
    template_version: TEMPLATE_VERSION,
    job_title: jobTitle,
    company: company || '',
    contact: normalizeContact(contact),
    items,
  };
}

export function normalizeContact(c = {}) {
  return {
    name: String(c.name || '').trim(),
    email: String(c.email || '').trim(),
    phone: String(c.phone || '').trim(),
    location: String(c.location || '').trim(),
    website: String(c.website || '').trim(),
  };
}

export function snapshotText(snap) {
  const parts = [snap.job_title, snap.company, Object.values(snap.contact).join(' ')];
  for (const it of snap.items) parts.push(it.title, it.body, it.tags.join(' '));
  return parts.join('\n');
}

// 渲染前再次复核（任务可能排队数秒，期间作品被转私密）
export function recheckSnapshot(snapshot) {
  const blocked = [];
  for (const it of snapshot.items || []) {
    const s = getSource(it.source_id);
    if (!s || !s.visible) blocked.push({ id: it.source_id, reason: !s ? 'deleted' : 'private' });
  }
  return blocked;
}
