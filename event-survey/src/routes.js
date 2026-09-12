'use strict';

// 路由表：method + path 模式（:param 路径参数）。
const { ok, readJsonBody, currentUser, requireUser, requireOrganizer } = require('./http-util');
const userService = require('./services/user-service');
const eventService = require('./services/event-service');
const registrationService = require('./services/registration-service');
const submissionService = require('./services/submission-service');

const bearer = (req) => {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
};

const routes = [];
function route(method, pattern, handler) {
  const names = [];
  const regex = new RegExp(
    `^${pattern.replace(/:[^/]+/g, (m) => {
      names.push(m.slice(1));
      return '([^/]+)';
    })}$`
  );
  routes.push({ method, regex, names, handler });
}

// ---------- 认证 ----------
route('POST', '/api/auth/register', async (req, res) => {
  const body = await readJsonBody(req);
  ok(res, userService.register(body), '注册成功');
});

route('POST', '/api/auth/login', async (req, res) => {
  const body = await readJsonBody(req);
  ok(res, userService.login(body), '登录成功');
});

route('POST', '/api/auth/logout', (req, res) => {
  const token = bearer(req);
  if (token) userService.logout(token);
  ok(res, null, '已登出');
});

route('GET', '/api/auth/me', (req, res) => {
  const user = requireUser(req);
  ok(res, { id: user.id, username: user.username, nickname: user.nickname, role: user.role });
});

// ---------- 活动与问卷 ----------

// 已发布活动列表（所有人可见）
route('GET', '/api/events', (req, res) => {
  ok(res, eventService.listPublishedEvents());
});

// 我（组织者）创建的活动
route('GET', '/api/events/mine', (req, res) => {
  const organizer = requireOrganizer(req);
  ok(res, eventService.listMyEvents(organizer));
});

// 创建活动 + 问卷（组织者）
route('POST', '/api/events', async (req, res) => {
  const organizer = requireOrganizer(req);
  const body = await readJsonBody(req);
  ok(res, eventService.createEvent(organizer, body), '活动已创建（草稿）');
});

// 活动详情：已发布任何人可见问卷；草稿仅创建者
route('GET', '/api/events/:id', (req, res, p) => {
  const user = currentUser(req);
  ok(res, eventService.eventView(eventService.getVisibleEvent(p.id, user)));
});

// 编辑活动/问卷（仅草稿状态、仅创建者）
route('PUT', '/api/events/:id', async (req, res, p) => {
  const organizer = requireOrganizer(req);
  const body = await readJsonBody(req);
  ok(res, eventService.updateEvent(organizer, p.id, body), '活动已更新');
});

// 发布活动（发布后问卷开放、题目锁定）
route('POST', '/api/events/:id/publish', (req, res, p) => {
  const organizer = requireOrganizer(req);
  ok(res, eventService.publishEvent(organizer, p.id), '活动已发布');
});

// ---------- 报名 ----------

route('POST', '/api/events/:id/register', (req, res, p) => {
  const user = requireUser(req);
  ok(res, registrationService.registerForEvent(user, p.id), '报名成功');
});

route('GET', '/api/registrations/mine', (req, res) => {
  const user = requireUser(req);
  ok(res, registrationService.listMyRegistrations(user));
});

// 当前用户对某活动的报名/提交状态
route('GET', '/api/events/:id/my-submission', (req, res, p) => {
  const user = requireUser(req);
  ok(res, submissionService.mySubmission(user, p.id));
});

// ---------- 问卷提交 ----------

route('POST', '/api/events/:id/submissions', async (req, res, p) => {
  const user = requireUser(req);
  const body = await readJsonBody(req);
  ok(res, submissionService.submitSurvey(user, p.id, body), '提交成功');
});

// ---------- 组织者结果看板 ----------

route('GET', '/api/events/:id/results', (req, res, p) => {
  const organizer = requireOrganizer(req);
  ok(res, submissionService.getResults(organizer, p.id));
});

async function dispatch(req, res, pathname) {
  const match = routes.find((r) => r.method === req.method && r.regex.test(pathname));
  if (!match) return false;
  const m = pathname.match(match.regex);
  const params = {};
  match.names.forEach((name, i) => {
    params[name] = decodeURIComponent(m[i + 1]);
  });
  await match.handler(req, res, params);
  return true;
}

module.exports = { dispatch };
