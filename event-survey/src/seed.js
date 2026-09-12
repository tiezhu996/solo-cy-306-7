'use strict';

// 种子数据：创建演示账号与一个示例活动（默认不发布，便于演示「发布前问卷不开放」）。
// 用法：npm run seed    （重复执行会先清空 data 目录）
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { store } = require('./store');
const { hashPassword, issueToken } = require('./auth');
const { now } = require('./util');

// 重置数据目录
for (const file of fs.readdirSync(config.dataDir)) {
  fs.rmSync(path.join(config.dataDir, file), { recursive: true, force: true });
}
// store 已在 require 时加载过空数据，重置内存集合
for (const name of Object.keys(store.data)) store.data[name].splice(0);

const t = now();
const users = [
  { id: 'usr_organizer', username: 'organizer', nickname: '王组织者', role: 'organizer', password: 'Org@1234' },
  { id: 'usr_alice', username: 'alice', nickname: '爱丽丝', role: 'participant', password: 'User@1234' },
  { id: 'usr_bob', username: 'bob', nickname: '鲍勃', role: 'participant', password: 'User@1234' },
].map(({ password, ...u }) => ({ ...u, passwordHash: hashPassword(password), createdAt: t }));

users.forEach((u) => store.insert('users', u));

const demoEvent = {
  id: 'evt_demo',
  organizerId: 'usr_organizer',
  title: '2026 秋季技术沙龙',
  description: '围绕前后端工程实践的线下分享会，欢迎已报名的同学填写活动反馈问卷。',
  status: 'draft',
  createdAt: t,
  publishedAt: null,
  questions: [
    { id: 'que_satisfaction', type: 'single', title: '你对本次活动的整体满意度？', required: true,
      options: [
        { id: 'opt_s1', label: '非常满意' },
        { id: 'opt_s2', label: '满意' },
        { id: 'opt_s3', label: '一般' },
        { id: 'opt_s4', label: '不满意' },
      ] },
    { id: 'que_topics', type: 'multi', title: '你希望今后增加哪些主题？（可多选）', required: false,
      options: [
        { id: 'opt_t1', label: '前端工程化' },
        { id: 'opt_t2', label: '后端架构' },
        { id: 'opt_t3', label: 'AI 应用' },
        { id: 'opt_t4', label: 'DevOps' },
      ] },
    { id: 'que_comment', type: 'text', title: '其他建议（选填）', required: false, options: null },
  ],
};
store.insert('events', demoEvent);

// 给每个用户签发一个长期有效令牌，方便命令行调试
for (const u of users) {
  store.insert('tokens', { token: issueToken(u.id), userId: u.id, createdAt: t });
}

console.log('种子数据已写入:', config.dataDir);
console.log('演示账号:');
console.log('  组织者   organizer / Org@1234');
console.log('  参与者   alice     / User@1234');
console.log('  参与者   bob       / User@1234 （未报名，用于演示未报名被拒绝）');
console.log('示例活动: evt_demo（草稿状态，组织者登录后可发布）');
process.exit(0);
