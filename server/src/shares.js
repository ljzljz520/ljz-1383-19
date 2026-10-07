import crypto from 'node:crypto';
import { db, id, now } from './db.js';
import { SERVER_SECRET } from './config.js';

const b64url = (b) => Buffer.from(b).toString('base64url');

export function createShare({ resumeId, resumeVersionId, mode, ttlSeconds }) {
  const token = crypto.randomBytes(18).toString('base64url');
  const exp = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const sid = id('share');
  db.prepare(`INSERT INTO shares(id,token,resume_id,resume_version_id,mode,revoked,expires_at,created_at)
    VALUES(?,?,?,?,?,0,?,?)`).run(sid, token, resumeId, resumeVersionId, mode, exp, now());
  return db.prepare('SELECT * FROM shares WHERE id=?').get(sid);
}

export function revokeShare(token) {
  const s = db.prepare('SELECT * FROM shares WHERE token=?').get(token);
  if (!s) return null;
  db.prepare('UPDATE shares SET revoked=1 WHERE id=?').run(s.id);
  return db.prepare('SELECT * FROM shares WHERE id=?').get(s.id);
}

export function logAccess(shareId, result, ip, detail) {
  db.prepare('INSERT INTO share_access(id,share_id,ts,result,ip,detail) VALUES(?,?,?,?,?,?)')
    .run(id('acc'), shareId, now(), result, ip || null, detail || null);
}

// —— 受控代理：每次访问都由服务器验证（到期/撤销即时生效）——
export function validateProxyToken(token, ip) {
  const s = db.prepare('SELECT * FROM shares WHERE token=? AND mode=?').get(token, 'proxy');
  if (!s) { return { ok: false, status: 404, code: 'NOT_FOUND' }; }
  if (s.revoked) { logAccess(s.id, 'revoked', ip); return { ok: false, status: 410, code: 'REVOKED' }; }
  if (new Date(s.expires_at).getTime() < Date.now()) { logAccess(s.id, 'expired', ip); return { ok: false, status: 410, code: 'EXPIRED' }; }
  logAccess(s.id, 'ok', ip);
  return { ok: true, share: s };
}

// —— 离线签名 URL：HMAC(versionId,exp) ——
// 只要签名有效且未到期，持链接者无需连库即可验证；因此“有效期内不能即时撤销”，
// 紧急撤回只能轮换 SERVER_SECRET（会同时作废全部签名链接），故只用短 TTL。
export function signUrl(resumeVersionId, expiresAtMs) {
  const body = `${resumeVersionId}.${expiresAtMs}`;
  const sig = crypto.createHmac('sha256', SERVER_SECRET).update(body).digest('base64url');
  return { v: resumeVersionId, exp: expiresAtMs, sig };
}

export function verifySigned({ v, exp, sig }, ip) {
  if (!v || !exp || !sig) return { ok: false, status: 403, code: 'BAD_SIGNATURE' };
  const body = `${v}.${exp}`;
  const expect = crypto.createHmac('sha256', SERVER_SECRET).update(body).digest('base64url');
  const given = Buffer.from(sig);
  if (given.length !== Buffer.from(expect).length || !crypto.timingSafeEqual(given, Buffer.from(expect))) {
    return { ok: false, status: 403, code: 'BAD_SIGNATURE' };
  }
  if (Number(exp) < Date.now()) return { ok: false, status: 410, code: 'EXPIRED' };
  // 有效期内：不查库（离线验证）。不检查 revoked——这是签名模式的明确边界。
  const ver = db.prepare('SELECT * FROM resume_versions WHERE id=?').get(v);
  if (!ver) return { ok: false, status: 404, code: 'NOT_FOUND' };
  return { ok: true, version: ver, expiresAtMs: Number(exp) };
}

export function buildLinks(share, origin) {
  if (share.mode === 'proxy') {
    const u = `${origin}/s/${share.token}`;
    return { mode: 'proxy', preview: u, download: `${u}/dl`, expires_at: share.expires_at,
      revocable_instant: true, offline: false,
      cache_policy: 'Cache-Control: no-store（每次访问都回服务器校验，撤销/到期即时生效）' };
  }
  const exp = new Date(share.expires_at).getTime();
  const q = new URLSearchParams(signUrl(share.resume_version_id, exp)).toString();
  const u = `${origin}/signed/pdf?${q}`;
  const ttlSec = Math.round((exp - Date.now()) / 1000);
  return { mode: 'signed', download: u, expires_at: share.expires_at, ttl_seconds: ttlSec,
    revocable_instant: false, offline: true,
    cache_policy: `仅允许短缓存：Cache-Control: private, max-age<=${ttlSec}, must-revalidate；到期即失效。有效期内不能声称即时撤销（紧急撤回需轮换 SERVER_SECRET，全部签名链接同时作废）` };
}
