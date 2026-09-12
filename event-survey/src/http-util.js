'use strict';

// HTTP 辅助：JSON 收发、鉴权取用户、静态文件托管。
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { store } = require('./store');
const { verifyToken } = require('./auth');
const config = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 统一错误对象，路由层抛出后由 server 转换为 JSON 响应。
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function ok(res, data, message = 'ok') {
  sendJson(res, 200, { code: 0, message, data });
}

function fail(res, status, code, message) {
  sendJson(res, status, { code, message, data: null });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 1MB 限制'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parse(req) {
  const url = new URL(req.url, 'http://localhost');
  return { path: url.pathname, query: url.searchParams };
}

// 从 Authorization: Bearer <token> 解析当前用户；缺失/无效返回 null（不直接拒绝，由路由决定是否必须登录）。
function currentUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  // 登出后令牌失效：token 必须仍在 tokens 集合中
  const alive = store.find('tokens', (t) => t.token === token);
  if (!alive) return null;
  return store.find('users', (u) => u.id === payload.uid) || null;
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  return user;
}

function requireOrganizer(req) {
  const user = requireUser(req);
  if (user.role !== 'organizer') {
    throw new HttpError(403, 'FORBIDDEN', '仅组织者可执行该操作');
  }
  return user;
}

// 托管 public/ 静态文件；防目录穿越；未知路径回退 index.html（SPA）。
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(config.publicDir, rel));
  if (!filePath.startsWith(config.publicDir)) {
    fail(res, 403, 'FORBIDDEN', '非法路径');
    return true;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }
  // SPA 回退
  const index = path.join(config.publicDir, 'index.html');
  if (fs.existsSync(index)) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    fs.createReadStream(index).pipe(res);
    return true;
  }
  return false;
}

module.exports = { HttpError, sendJson, ok, fail, readJsonBody, parse, currentUser, requireUser, requireOrganizer, serveStatic };
