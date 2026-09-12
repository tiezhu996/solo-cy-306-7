'use strict';

const { store } = require('../store');
const { HttpError } = require('../http-util');
const { id, now } = require('../util');
const { getEventOrThrow } = require('./event-service');

function isRegistered(eventId, userId) {
  return Boolean(store.find('registrations', (r) => r.eventId === eventId && r.userId === userId));
}

// 报名：只有已发布活动可报名；同一用户对同一活动只能报名一次。
function registerForEvent(user, eventId) {
  if (user.role !== 'participant') {
    throw new HttpError(403, 'FORBIDDEN', '只有参与者账号可以报名活动');
  }
  const event = getEventOrThrow(eventId);
  if (event.status !== 'published') {
    throw new HttpError(409, 'EVENT_NOT_PUBLISHED', '活动尚未发布，暂不能报名');
  }
  if (isRegistered(eventId, user.id)) {
    throw new HttpError(409, 'ALREADY_REGISTERED', '你已经报名过该活动，请勿重复报名');
  }
  const registration = { id: id('reg'), eventId, userId: user.id, createdAt: now() };
  store.insert('registrations', registration);
  return {
    id: registration.id,
    eventId: event.id,
    eventTitle: event.title,
    createdAt: registration.createdAt,
  };
}

function listMyRegistrations(user) {
  return store
    .filter('registrations', (r) => r.userId === user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const event = store.find('events', (e) => e.id === r.eventId);
      const submitted = Boolean(store.find('submissions', (s) => s.eventId === r.eventId && s.userId === user.id));
      return {
        id: r.id,
        eventId: r.eventId,
        eventTitle: event ? event.title : '（活动已删除）',
        status: event ? event.status : 'unknown',
        submitted,
        createdAt: r.createdAt,
      };
    });
}

module.exports = { registerForEvent, listMyRegistrations, isRegistered };
