'use strict';

// 轻量令牌工具：payload 为 { uid, exp }，签名防篡改（HMAC-SHA256）。
// 这是演示用的无状态令牌；服务端额外维护 tokens 集合以支持登出失效。
const crypto = require('crypto');
const config = require('./config');

function sign(payloadB64) {
  return crypto.createHmac('sha256', config.tokenSecret).update(payloadB64).digest('base64url');
}

function issueToken(userId) {
  const payload = { uid: userId, exp: Date.now() + config.tokenTtlMs };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expected = sign(payloadB64);
  // 定长比较防时序泄露
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// 演示用密码哈希：salt + 1000 轮 sha256。非 bcrypt，但绝不存明文。
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  let h = `${salt}:${password}`;
  for (let i = 0; i < 1000; i++) {
    h = crypto.createHash('sha256').update(h).digest('hex');
  }
  return `${salt}$${h}`;
}

function checkPassword(password, stored) {
  const [salt] = stored.split('$');
  return hashPassword(password, salt) === stored;
}

module.exports = { issueToken, verifyToken, hashPassword, checkPassword };
