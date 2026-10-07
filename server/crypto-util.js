// 签名 URL：HMAC-SHA256。签名覆盖“目标 + 到期 + 撤销版本”，
// 离线可验签的链接在有效期内无法即时撤销（这是密码学事实，已在产品中显式告知）。
const crypto = require('crypto');

const DATA_DIR = process.env.RESUME_DATA_DIR ? require('path').resolve(process.env.RESUME_DATA_DIR) : require('path').join(__dirname, '..', 'resume-data');
const SECRET_FILE = require('path').join(DATA_DIR, 'secret.key');
const fs = require('fs');

function getSecret() {
  if (!fs.existsSync(SECRET_FILE)) {
    fs.mkdirSync(require('path').dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32));
  }
  return fs.readFileSync(SECRET_FILE);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload) {
  return b64url(crypto.createHmac('sha256', getSecret()).update(payload).digest());
}

// 为离线签名下载链接生成令牌：绑定具体分享 id（撤销该分享即作废，在线校验时）
function makeDownloadToken(shareId, docId, expiresAt) {
  const payload = `dl:${shareId}:${docId}:${expiresAt}`;
  return `${b64url(payload)}.${sign(payload)}`;
}

// 离线验签（不查库即可确认完整性与有效期；撤销检查需查库另行进行）
function verifyDownloadToken(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return { ok: false, reason: 'malformed' };
  let payload;
  try { payload = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(); }
  catch { return { ok: false, reason: 'malformed' }; }
  const expected = sign(payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'dl') return { ok: false, reason: 'malformed' };
  const [, shareId, docId, expStr] = parts;
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, shareId, docId, expiresAt };
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

module.exports = { makeDownloadToken, verifyDownloadToken, newId, b64url };
