'use strict';

const { store } = require('../store');
const { HttpError } = require('../http-util');
const { id, now, trim } = require('../util');
const { getEventOrThrow, getVisibleEvent, requireOwner, eventView } = require('./event-service');
const { isRegistered } = require('./registration-service');

// 校验答案值：返回规范化后的答案 { questionId, type, value }
function normalizeAnswer(question, raw) {
  if (question.type === 'text') {
    const value = trim(raw);
    if (question.required && !value) {
      throw new HttpError(400, 'ANSWER_REQUIRED', `「${question.title}」为必填项`);
    }
    if (value.length > 2000) throw new HttpError(400, 'ANSWER_TOO_LONG', `「${question.title}」答案不能超过 2000 字`);
    return { questionId: question.id, value };
  }

  const optionIds = new Set(question.options.map((o) => o.id));

  if (question.type === 'single') {
    const value = raw == null ? null : String(raw);
    if (question.required && !value) {
      throw new HttpError(400, 'ANSWER_REQUIRED', `「${question.title}」为必填项`);
    }
    if (value !== null && !optionIds.has(value)) {
      throw new HttpError(400, 'INVALID_OPTION', `「${question.title}」选择了不存在的选项`);
    }
    return { questionId: question.id, value: value || null };
  }

  // multi
  if (!Array.isArray(raw)) {
    if (question.required) throw new HttpError(400, 'ANSWER_REQUIRED', `「${question.title}」为必填项`);
    return { questionId: question.id, value: [] };
  }
  const values = raw.map(String);
  if (values.some((v) => !optionIds.has(v))) {
    throw new HttpError(400, 'INVALID_OPTION', `「${question.title}」选择了不存在的选项`);
  }
  const unique = [...new Set(values)];
  if (question.required && unique.length === 0) {
    throw new HttpError(400, 'ANSWER_REQUIRED', `「${question.title}」为必填项`);
  }
  return { questionId: question.id, value: unique };
}

// 提交问卷反馈。核心业务规则：
// 1) 活动必须已发布（发布后问卷才开放）；
// 2) 提交者必须是参与者且已报名该活动（未报名拒绝）；
// 3) 同一用户对同一活动只能提交一次（重复提交拒绝）；
// 4) 所有必答题必须作答，选择题选项必须合法。
function submitSurvey(user, eventId, body) {
  const event = getEventOrThrow(eventId);

  if (event.status !== 'published') {
    throw new HttpError(409, 'SURVEY_NOT_OPEN', '活动尚未发布，问卷未开放');
  }
  if (user.role !== 'participant') {
    throw new HttpError(403, 'FORBIDDEN', '只有参与者可以提交问卷');
  }
  if (!isRegistered(eventId, user.id)) {
    throw new HttpError(403, 'NOT_REGISTERED', '未报名该活动，不能提交问卷');
  }
  const existing = store.find('submissions', (s) => s.eventId === eventId && s.userId === user.id);
  if (existing) {
    throw new HttpError(409, 'ALREADY_SUBMITTED', '你已提交过该问卷，每人只能提交一次');
  }

  const rawAnswers = body && typeof body.answers === 'object' && body.answers !== null ? body.answers : {};
  const answers = event.questions.map((q) => {
    if (!Object.prototype.hasOwnProperty.call(rawAnswers, q.id)) {
      if (q.required) throw new HttpError(400, 'ANSWER_REQUIRED', `「${q.title}」为必填项`);
      return normalizeAnswer(q, q.type === 'multi' ? [] : null);
    }
    return normalizeAnswer(q, rawAnswers[q.id]);
  });

  const submission = {
    id: id('sub'),
    eventId,
    userId: user.id,
    answers,
    createdAt: now(),
  };
  store.insert('submissions', submission);

  return {
    id: submission.id,
    eventId,
    submittedAt: submission.createdAt,
    message: '问卷提交成功',
  };
}

// 当前用户对某活动的提交状态：供前端决定显示「去填写」还是「已提交」。
function mySubmission(user, eventId) {
  const event = getVisibleEvent(eventId, user);
  const registered = isRegistered(eventId, user.id);
  const submission = store.find('submissions', (s) => s.eventId === eventId && s.userId === user.id);
  return {
    eventId,
    eventStatus: event.status,
    registered,
    open: event.status === 'published' && registered,
    submitted: Boolean(submission),
    submittedAt: submission ? submission.createdAt : null,
  };
}

// 组织者查看结果：提交人数 + 每题选项人数分布 + 文本答案列表。
function getResults(organizer, eventId) {
  const event = store.find('events', (e) => e.id === eventId);
  if (!event) throw new HttpError(404, 'EVENT_NOT_FOUND', '活动不存在');
  requireOwner(event, organizer);

  const submissions = store
    .filter('submissions', (s) => s.eventId === eventId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const userNickname = (uid) => {
    const u = store.find('users', (x) => x.id === uid);
    return u ? u.nickname : '未知用户';
  };

  const questionResults = event.questions.map((q) => {
    const base = {
      questionId: q.id,
      title: q.title,
      type: q.type,
      required: q.required,
      answeredCount: 0,
    };

    if (q.type === 'single' || q.type === 'multi') {
      // 每个选项给出人数；另统计作答人数（单选=非空人数，多选=选了至少一项的人数）
      const counts = new Map(q.options.map((o) => [o.id, 0]));
      let answered = 0;
      for (const s of submissions) {
        const a = s.answers.find((x) => x.questionId === q.id);
        if (!a) continue;
        if (q.type === 'single') {
          if (a.value) {
            answered += 1;
            counts.set(a.value, (counts.get(a.value) || 0) + 1);
          }
        } else if (Array.isArray(a.value) && a.value.length > 0) {
          answered += 1;
          for (const opt of a.value) counts.set(opt, (counts.get(opt) || 0) + 1);
        }
      }
      return {
        ...base,
        answeredCount: answered,
        options: q.options.map((o) => ({
          optionId: o.id,
          label: o.label,
          count: counts.get(o.id) || 0,
        })),
      };
    }

    // 文本题：逐条列出答案
    const textAnswers = [];
    for (const s of submissions) {
      const a = s.answers.find((x) => x.questionId === q.id);
      if (a && a.value) textAnswers.push({ userId: s.userId, nickname: userNickname(s.userId), value: a.value, submittedAt: s.createdAt });
    }
    return { ...base, answeredCount: textAnswers.length, textAnswers };
  });

  return {
    event: eventView(event),
    registeredCount: store.filter('registrations', (r) => r.eventId === eventId).length,
    submissionCount: submissions.length,
    questions: questionResults,
  };
}

module.exports = { submitSurvey, mySubmission, getResults };
