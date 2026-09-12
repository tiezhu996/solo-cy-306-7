'use strict';

const { store } = require('../store');
const { HttpError } = require('../http-util');
const { id, now, trim } = require('../util');

const QUESTION_TYPES = ['single', 'multi', 'text'];
const MAX_OPTIONS = 10;

// ---------- 问卷题目校验 ----------

function validateQuestion(q, index) {
  const where = `第 ${index + 1} 题`;
  if (!q || typeof q !== 'object') throw new HttpError(400, 'INVALID_QUESTION', `${where}格式不正确`);
  const type = q.type;
  if (!QUESTION_TYPES.includes(type)) {
    throw new HttpError(400, 'INVALID_QUESTION_TYPE', `${where}题型必须是 single / multi / text`);
  }
  const title = trim(q.title);
  if (!title) throw new HttpError(400, 'INVALID_QUESTION_TITLE', `${where}题目标题不能为空`);
  if (title.length > 200) throw new HttpError(400, 'INVALID_QUESTION_TITLE', `${where}题目标题不能超过 200 字`);

  const question = {
    id: q.id || id('que'),
    type,
    title,
    required: Boolean(q.required),
    options: null,
  };

  if (type === 'single' || type === 'multi') {
    if (!Array.isArray(q.options) || q.options.length < 2) {
      throw new HttpError(400, 'INVALID_OPTIONS', `${where}至少需要 2 个选项`);
    }
    if (q.options.length > MAX_OPTIONS) {
      throw new HttpError(400, 'INVALID_OPTIONS', `${where}选项不能超过 ${MAX_OPTIONS} 个`);
    }
    const labels = [];
    question.options = q.options.map((opt) => {
      const label = trim(opt);
      if (!label) throw new HttpError(400, 'INVALID_OPTION_LABEL', `${where}选项内容不能为空`);
      if (labels.includes(label)) throw new HttpError(400, 'DUPLICATE_OPTION', `${where}选项不能重复：${label}`);
      labels.push(label);
      return { id: id('opt'), label };
    });
  }
  return question;
}

function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new HttpError(400, 'NO_QUESTIONS', '问卷至少包含 1 道题');
  }
  if (questions.length > 50) throw new HttpError(400, 'TOO_MANY_QUESTIONS', '问卷题目不能超过 50 道');
  return questions.map((q, i) => validateQuestion(q, i));
}

// ---------- 活动 / 问卷 ----------

function getEventOrThrow(eventId) {
  const event = store.find('events', (e) => e.id === eventId);
  if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', '活动不存在');
  return event;
}

// 草稿仅组织者本人可见；已发布活动所有人可见。
function getVisibleEvent(eventId, user) {
  const event = getEventOrThrow(eventId);
  if (event.status === 'draft' && (!user || user.id !== event.organizerId)) {
    throw new HttpError(404, 'EVENT_NOT_FOUND', '活动不存在');
  }
  return event;
}

function requireOwner(event, user) {
  if (user.role !== 'organizer' || event.organizerId !== user.id) {
    throw new HttpError(403, 'FORBIDDEN', '只能操作自己创建的活动');
  }
}

// 对外视图：发布后任何人都能看到问卷题目；草稿只有创建者能看。
function eventView(event, { includeQuestions = true } = {}) {
  const organizer = store.find('users', (u) => u.id === event.organizerId);
  const view = {
    id: event.id,
    title: event.title,
    description: event.description,
    status: event.status,
    organizerName: organizer ? organizer.nickname : '未知组织者',
    createdAt: event.createdAt,
    publishedAt: event.publishedAt || null,
    registeredCount: store.filter('registrations', (r) => r.eventId === event.id).length,
    submissionCount: store.filter('submissions', (s) => s.eventId === event.id).length,
  };
  if (includeQuestions) view.questions = event.questions;
  return view;
}

function createEvent(organizer, payload) {
  const title = trim(payload.title);
  if (!title) throw new HttpError(400, 'INVALID_TITLE', '活动标题不能为空');
  const event = {
    id: id('evt'),
    organizerId: organizer.id,
    title,
    description: trim(payload.description),
    status: 'draft',
    questions: validateQuestions(payload.questions),
    createdAt: now(),
    publishedAt: null,
  };
  store.insert('events', event);
  return eventView(event);
}

function updateEvent(organizer, eventId, payload) {
  const event = getEventOrThrow(eventId);
  requireOwner(event, organizer);
  if (event.status !== 'draft') {
    throw new HttpError(409, 'EVENT_ALREADY_PUBLISHED', '活动已发布，问卷题目已锁定，不能再编辑');
  }
  const patch = {};
  if (payload.title !== undefined) {
    const title = trim(payload.title);
    if (!title) throw new HttpError(400, 'INVALID_TITLE', '活动标题不能为空');
    patch.title = title;
  }
  if (payload.description !== undefined) patch.description = trim(payload.description);
  if (payload.questions !== undefined) patch.questions = validateQuestions(payload.questions);
  store.update('events', (e) => e.id === event.id, patch);
  return eventView(getEventOrThrow(event.id));
}

function publishEvent(organizer, eventId) {
  const event = getEventOrThrow(eventId);
  requireOwner(event, organizer);
  if (event.status === 'published') {
    throw new HttpError(409, 'EVENT_ALREADY_PUBLISHED', '活动已经发布');
  }
  store.update('events', (e) => e.id === event.id, { status: 'published', publishedAt: now() });
  return eventView(getEventOrThrow(event.id));
}

function listMyEvents(organizer) {
  return store
    .filter('events', (e) => e.organizerId === organizer.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((e) => eventView(e));
}

function listPublishedEvents() {
  return store
    .filter('events', (e) => e.status === 'published')
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .map((e) => eventView(e, { includeQuestions: false }));
}

module.exports = {
  QUESTION_TYPES,
  getEventOrThrow,
  getVisibleEvent,
  requireOwner,
  eventView,
  createEvent,
  updateEvent,
  publishEvent,
  listMyEvents,
  listPublishedEvents,
};
