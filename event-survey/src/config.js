'use strict';

// 集中配置：全部可通过环境变量覆盖，默认值保证开箱即用。
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  publicDir: path.join(ROOT, 'public'),
  // 令牌在演示场景下使用固定签名盐；生产请通过环境变量注入随机值。
  tokenSecret: process.env.TOKEN_SECRET || 'event-survey-dev-secret',
  tokenTtlMs: 7 * 24 * 60 * 60 * 1000,
};

module.exports = config;
