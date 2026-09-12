'use strict';

// 服务入口：装配 HTTP 服务、API 路由、统一错误处理、静态页面托管。
const http = require('http');
const config = require('./config');
const { parse, fail, serveStatic, HttpError } = require('./http-util');
const { dispatch } = require('./routes');

const server = http.createServer(async (req, res) => {
  const { path: pathname } = parse(req);

  // 简单 CORS（方便开发期其他端口调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname.startsWith('/api/')) {
      const handled = await dispatch(req, res, pathname);
      if (!handled) fail(res, 404, 'NOT_FOUND', `接口不存在：${req.method} ${pathname}`);
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', time: new Date().toISOString() }));
    }
    if (!serveStatic(req, res, pathname)) {
      fail(res, 404, 'NOT_FOUND', '资源不存在');
    }
  } catch (err) {
    if (err instanceof HttpError) {
      fail(res, err.status, err.code, err.message);
    } else {
      console.error('[unhandled]', err);
      fail(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
    }
  }
});

server.listen(config.port, config.host, () => {
  console.log(`活动问卷反馈系统已启动: http://localhost:${config.port}`);
  console.log(`数据目录: ${config.dataDir}`);
});

module.exports = server;
