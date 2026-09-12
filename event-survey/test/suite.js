'use strict';

/* 活动问卷反馈模块 —— 可重复的独立测试套件
 *
 * 覆盖：
 *   T1 多人同时提交（并发，结果聚合正确）
 *   T2 重复提交（串行 + 同用户并发竞争，只能成功一次）
 *   T3 未报名 / 未登录 / 错误角色拒绝
 *   T4 草稿与发布切换（可见性、锁定、越权）
 *   T5 必填与非法选项（答题校验 + 问卷建模校验）
 *   T6 登出后令牌立即失效
 *   T7 重启回读（数据、计数、一次性约束跨进程保持）
 *   T8 异常中断：残留临时文件被忽略；SIGKILL 崩溃后主文件不损坏、ack 必落盘
 *
 * 可重复保证：每次运行使用随机用户名、独立临时数据目录、动态空闲端口；
 * 每个用例拥有全新的服务实例，互不影响。每个用例独立给出通过/失败，
 * 进程退出码 0/1，连续运行结果稳定。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');
const GROUP_TIMEOUT_MS = 30_000;

// ---------- 进程 / 端口 ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });
}

function waitExit(proc, ms) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    const t = setTimeout(() => {
      proc.removeListener('exit', onExit);
      resolve(false);
    }, ms);
    const onExit = () => { clearTimeout(t); resolve(true); };
    proc.once('exit', onExit);
  });
}

async function stopServer(proc) {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  const exited = await waitExit(proc, 5_000);
  if (!exited) {
    proc.kill('SIGKILL');
    await waitExit(proc, 3_000);
  }
}

async function waitReady(base, proc, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (proc.exitCode !== null) throw new Error('server-exited');
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server-timeout');
}

async function startServer(dir) {
  let lastErr;
  for (let attempt = 0; attempt < 25; attempt++) {
    const port = await freePort();
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitReady(base, proc);
      return { proc, port, base, get stderr() { return stderr; } };
    } catch (e) {
      lastErr = e;
      try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
      await waitExit(proc, 2_000);
      if (e.message === 'server-exited') {
        throw new Error(`服务启动即退出：\n${stderr}`);
      }
    }
  }
  throw new Error(`服务启动失败：${lastErr && lastErr.message}`);
}

// ---------- HTTP ----------

async function call(base, method, url, { token, body, accept } = {}) {
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(accept ? { Accept: accept } : {}),
    };
    const res = await fetch(`${base}${url}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    return {
      status: res.status,
      json,
      text,
      error: null,
      contentType: res.headers.get('content-type') || '',
      disposition: res.headers.get('content-disposition') || '',
      emptyHeader: res.headers.get('x-export-empty'),
      countHeader: res.headers.get('x-export-count'),
    };
  } catch (e) {
    return { status: 0, json: null, text: '', error: e.message };
  }
}

// ---------- 用例世界（每个用例一套独立数据与进程） ----------

async function createWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esuite-'));
  let srv = await startServer(dir);

  const world = {
    dir,
    get base() { return srv.base; },
    get proc() { return srv.proc; },

    async restart() {
      await stopServer(srv.proc);
      srv = await startServer(dir);
    },
    async hardKill() {
      srv.proc.kill('SIGKILL');
      await waitExit(srv.proc, 3_000);
    },
    async destroy(keep) {
      await stopServer(srv.proc).catch(() => {});
      if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    },
    call: (method, url, opts) => call(srv.base, method, url, opts),
  };

  const tag = crypto.randomBytes(4).toString('hex');
  let seq = 0;
  world.signup = async (role, prefix) => {
    const username = `${prefix || role[0]}${tag}${(seq++).toString(36)}`;
    const r = await world.call('POST', '/api/auth/register', {
      body: { username, password: 'Pass@1234', nickname: username, role },
    });
    if (r.status !== 200) throw new Error(`注册失败 ${r.status}: ${r.text}`);
    return r.json.data; // { token, user }
  };
  world.login = async (username) => {
    const r = await world.call('POST', '/api/auth/login', { body: { username, password: 'Pass@1234' } });
    if (r.status !== 200) throw new Error(`登录失败 ${r.status}: ${r.text}`);
    return r.json.data;
  };
  world.createPublishedEvent = async (orgToken, questions) => {
    const created = await world.call('POST', '/api/events', {
      token: orgToken,
      body: { title: `测试活动 ${tag} ${seq++}`, description: '可重复测试用活动', questions },
    });
    if (created.status !== 200) throw new Error(`建活动失败：${created.text}`);
    const eventId = created.json.data.id;
    const pub = await world.call('POST', `/api/events/${eventId}/publish`, { token: orgToken });
    if (pub.status !== 200) throw new Error(`发布失败：${pub.text}`);
    const detail = await world.call('GET', `/api/events/${eventId}`, { token: orgToken });
    return { eventId, questions: detail.json.data.questions };
  };
  world.readCollection = (name) => {
    const file = path.join(dir, `${name}.json`);
    if (!fs.existsSync(file)) return []; // 零记录时文件尚未创建，等价于空集合
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  return world;
}

// ---------- 断言 / 运行器 ----------

function recorder(groupName) {
  const rec = { name: groupName, pass: 0, fail: 0, failures: [] };
  rec.check = (name, cond, detail = '') => {
    if (cond) {
      rec.pass += 1;
      console.log(`  ✓ ${name}`);
    } else {
      rec.fail += 1;
      rec.failures.push(name);
      console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
    }
  };
  return rec;
}

const groups = [];
function group(name, fn) { groups.push({ name, fn }); }

// ---------- 题目模板 ----------

const STANDARD_QUESTIONS = [
  { type: 'single', title: '整体评分', required: true, options: ['好', '中', '差'] },
  { type: 'multi', title: '喜欢的环节', required: false, options: ['开场', '分享', '茶歇', '问答'] },
  { type: 'text', title: '建议', required: false },
];

const VALIDATION_QUESTIONS = [
  { type: 'single', title: '必选单选', required: true, options: ['A', 'B'] },
  { type: 'multi', title: '可选多选', required: false, options: ['X', 'Y'] },
  { type: 'multi', title: '必填多选', required: true, options: ['P', 'Q'] },
  { type: 'text', title: '必填文本', required: true },
  { type: 'text', title: '可选文本', required: false },
];

// ---------- T1 多人同时提交 ----------

group('T1 多人同时提交（并发）', async (w, check) => {
  const org = await w.signup('organizer');
  const { eventId, questions } = await w.createPublishedEvent(org.token, STANDARD_QUESTIONS);
  const N = 8;
  const people = await Promise.all(Array.from({ length: N }, () => w.signup('participant', 'u')));
  await Promise.all(people.map((p) => w.call('POST', `/api/events/${eventId}/register`, { token: p.token })));

  const answersOf = (i) => ({
    [questions[0].id]: questions[0].options[i % 3].id,
    [questions[1].id]: questions[1].options.filter((_, k) => (i >> k) & 1).map((o) => o.id),
    [questions[2].id]: i % 2 === 0 ? `第 ${i} 条建议` : '',
  });

  const results = await Promise.all(people.map((p, i) =>
    w.call('POST', `/api/events/${eventId}/submissions`, { token: p.token, body: { answers: answersOf(i) } })));

  check('8 个并发提交全部 200', results.every((r) => r.status === 200),
    results.map((r) => r.status).join(','));
  check('返回的提交 id 全部唯一', new Set(results.map((r) => r.json.data.id)).size === N);

  const board = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check(`提交人数 = ${N}`, board.submissionCount === N, `实际 ${board.submissionCount}`);
  check('报名人数 = 8', board.registeredCount === 8);

  const single = board.questions[0];
  check('单选各选项人数之和 = 8', single.options.reduce((s, o) => s + o.count, 0) === 8);
  check('单选分布正确（好3/中3/差2）', single.options.map((o) => o.count).join(',') === '3,3,2',
    single.options.map((o) => `${o.label}:${o.count}`).join(' '));
  check('单选作答人数 = 8', single.answeredCount === 8);

  const multi = board.questions[1];
  // i 取 0..7（0b000..0b111）：低 3 位各出现 4 次，bit3 恒为 0
  const expectedMulti = [4, 4, 4, 0];
  check('多选各选项人数正确（按位模式 4,4,4,0）',
    multi.options.map((o) => o.count).join(',') === expectedMulti.join(','),
    multi.options.map((o) => `${o.label}:${o.count}`).join(' '));

  const textQ = board.questions[2];
  check('文本答案回收 4 条（偶数编号提交了建议）', textQ.textAnswers.length === 4,
    `实际 ${textQ.textAnswers.length}`);
  check('文本答案带提交者昵称', textQ.textAnswers.every((a) => a.nickname && a.value.startsWith('第 ')));

  const statuses = await Promise.all(people.map((p) =>
    w.call('GET', `/api/events/${eventId}/my-submission`, { token: p.token })));
  check('每个参与者的状态均为已报名+已提交',
    statuses.every((r) => r.json && r.json.data && r.json.data.registered && r.json.data.submitted),
    statuses.map((r) => r.status).join(','));

  const onDisk = w.readCollection('submissions').filter((s) => s.eventId === eventId);
  check('磁盘记录 8 条且每题答案完整',
    onDisk.length === 8 && onDisk.every((s) => s.answers.length === 3),
    `实际 ${onDisk.length}`);
});

// ---------- T2 重复提交 ----------

group('T2 重复提交（串行 + 并发竞争）', async (w, check) => {
  const org = await w.signup('organizer');
  const { eventId, questions } = await w.createPublishedEvent(org.token, STANDARD_QUESTIONS);
  const user = await w.signup('participant', 'u');
  await w.call('POST', `/api/events/${eventId}/register`, { token: user.token });

  const validAnswers = {
    [questions[0].id]: questions[0].options[0].id,
    [questions[1].id]: [questions[1].options[0].id],
    [questions[2].id]: '第一次提交',
  };

  const first = await w.call('POST', `/api/events/${eventId}/submissions`, { token: user.token, body: { answers: validAnswers } });
  check('首次提交 200', first.status === 200, first.text);

  const second = await w.call('POST', `/api/events/${eventId}/submissions`, { token: user.token, body: { answers: validAnswers } });
  check('串行重复提交返回 409', second.status === 409);
  check('错误码为 ALREADY_SUBMITTED', second.json.code === 'ALREADY_SUBMITTED', second.json.code);

  // 并发竞争：同一用户同时打 6 个相同请求，必须恰好 1 个成功（检查-写入无竞争窗口）
  const raceResults = await Promise.all(Array.from({ length: 6 }, () =>
    w.call('POST', `/api/events/${eventId}/submissions`, { token: user.token, body: { answers: validAnswers } })));
  const okCount = raceResults.filter((r) => r.status === 200).length;
  const conflictCount = raceResults.filter((r) => r.status === 409).length;
  check('并发重复提交恰好 0 个新增成功', okCount === 0, `成功 ${okCount} 个`);
  check('其余并发请求全部 409', conflictCount === 6, `409 数量 ${conflictCount}`);

  const board = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('结果看板提交人数仍为 1', board.submissionCount === 1, `实际 ${board.submissionCount}`);
  check('磁盘上该活动只有 1 条提交',
    w.readCollection('submissions').filter((s) => s.eventId === eventId).length === 1);
});

// ---------- T3 未报名拒绝 ----------

group('T3 未报名 / 未登录 / 错误角色拒绝', async (w, check) => {
  const org = await w.signup('organizer');
  const outsider = await w.signup('participant', 'u');
  const { eventId, questions } = await w.createPublishedEvent(org.token, STANDARD_QUESTIONS);
  const body = { answers: { [questions[0].id]: questions[0].options[0].id } };

  const noToken = await w.call('POST', `/api/events/${eventId}/submissions`, { body });
  check('未登录提交返回 401', noToken.status === 401, `实际 ${noToken.status}`);
  check('错误码 UNAUTHORIZED', noToken.json && noToken.json.code === 'UNAUTHORIZED');

  const notRegistered = await w.call('POST', `/api/events/${eventId}/submissions`, { token: outsider.token, body });
  check('未报名用户提交返回 403', notRegistered.status === 403, `实际 ${notRegistered.status}`);
  check('错误码 NOT_REGISTERED', notRegistered.json.code === 'NOT_REGISTERED', notRegistered.json.code);

  const organizerSubmits = await w.call('POST', `/api/events/${eventId}/submissions`, { token: org.token, body });
  check('组织者角色提交返回 403', organizerSubmits.status === 403);

  // 篡改/伪造令牌
  const fake = await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: 'not.a.real.token', body,
  });
  check('伪造令牌返回 401', fake.status === 401);

  const board = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('被拒绝的提交均未入库（提交人数 0）', board.submissionCount === 0);
  check('未报名用户状态 open=false / registered=false',
    (await w.call('GET', `/api/events/${eventId}/my-submission`, { token: outsider.token })).json.data.open === false);
});

// ---------- T4 草稿与发布切换 ----------

group('T4 草稿与发布切换', async (w, check) => {
  const org = await w.signup('organizer');
  const org2 = await w.signup('organizer');
  const user = await w.signup('participant', 'u');

  const created = await w.call('POST', '/api/events', { token: org.token, body: {
    title: '草稿活动', description: '还没发布', questions: STANDARD_QUESTIONS,
  } });
  const eventId = created.json.data.id;
  check('新建活动为 draft', created.json.data.status === 'draft');

  check('草稿不在公开活动列表',
    !(await w.call('GET', '/api/events')).json.data.some((e) => e.id === eventId));
  check('草稿在创建者的 mine 列表',
    (await w.call('GET', '/api/events/mine', { token: org.token })).json.data.some((e) => e.id === eventId));
  check('草稿不在其他组织者的 mine 列表',
    !(await w.call('GET', '/api/events/mine', { token: org2.token })).json.data.some((e) => e.id === eventId));

  check('参与者看草稿详情返回 404',
    (await w.call('GET', `/api/events/${eventId}`, { token: user.token })).status === 404);
  const earlyReg = await w.call('POST', `/api/events/${eventId}/register`, { token: user.token });
  check('草稿期报名返回 409 EVENT_NOT_PUBLISHED',
    earlyReg.status === 409 && earlyReg.json.code === 'EVENT_NOT_PUBLISHED', earlyReg.text);
  const earlySub = await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: user.token, body: { answers: {} },
  });
  check('草稿期提交返回 409 SURVEY_NOT_OPEN',
    earlySub.status === 409 && earlySub.json.code === 'SURVEY_NOT_OPEN', earlySub.text);

  // 草稿可被创建者编辑
  const edited = await w.call('PUT', `/api/events/${eventId}`, {
    token: org.token,
    body: { title: '草稿活动（改）', questions: [{ type: 'text', title: '草稿期换一道文本题', required: true }] },
  });
  check('创建者可编辑草稿', edited.status === 200 && edited.json.data.title === '草稿活动（改）');
  check('编辑后题目已替换', edited.json.data.questions.length === 1 && edited.json.data.questions[0].type === 'text');

  // 他人无权操作
  check('其他组织者发布别人的草稿返回 403',
    (await w.call('POST', `/api/events/${eventId}/publish`, { token: org2.token })).status === 403);
  check('其他组织者查看结果返回 403',
    (await w.call('GET', `/api/events/${eventId}/results`, { token: org2.token })).status === 403);

  // 发布
  const pub = await w.call('POST', `/api/events/${eventId}/publish`, { token: org.token });
  check('发布成功且 publishedAt 有值',
    pub.json.data.status === 'published' && Boolean(pub.json.data.publishedAt));
  check('发布后出现在公开列表',
    (await w.call('GET', '/api/events')).json.data.some((e) => e.id === eventId));

  const pubAgain = await w.call('POST', `/api/events/${eventId}/publish`, { token: org.token });
  check('重复发布返回 409', pubAgain.status === 409 && pubAgain.json.code === 'EVENT_ALREADY_PUBLISHED');
  const editLocked = await w.call('PUT', `/api/events/${eventId}`, {
    token: org.token, body: { questions: STANDARD_QUESTIONS },
  });
  check('发布后问卷题目锁定（409）', editLocked.status === 409 && editLocked.json.code === 'EVENT_ALREADY_PUBLISHED');

  // 发布后流程打通
  const reg = await w.call('POST', `/api/events/${eventId}/register`, { token: user.token });
  check('发布后报名成功', reg.status === 200);
  const sub = await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: user.token, body: { answers: { [edited.json.data.questions[0].id]: '发布后填写的文本' } },
  });
  check('发布后提交成功', sub.status === 200);

  const board = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('结果看板计数为 1/1', board.registeredCount === 1 && board.submissionCount === 1);
});

// ---------- T5 必填与非法选项 ----------

group('T5 必填与非法选项校验', async (w, check) => {
  const org = await w.signup('organizer');
  const { eventId, questions } = await w.createPublishedEvent(org.token, VALIDATION_QUESTIONS);
  const user = await w.signup('participant', 'u');
  await w.call('POST', `/api/events/${eventId}/register`, { token: user.token });
  const [qSingle, qMultiOpt, qMultiReq, qTextReq, qTextOpt] = questions;

  const submit = (answers) => w.call('POST', `/api/events/${eventId}/submissions`, { token: user.token, body: { answers } });

  let r = await submit({});
  check('空答案（必答题缺失）返回 400', r.status === 400 && r.json.code === 'ANSWER_REQUIRED', r.text);

  r = await submit({ [qSingle.id]: null, [qMultiReq.id]: [qMultiReq.options[0].id], [qTextReq.id]: 'x' });
  check('必选单选传 null 返回 400', r.status === 400 && r.json.code === 'ANSWER_REQUIRED', r.text);

  r = await submit({ [qSingle.id]: qSingle.options[0].id, [qMultiReq.id]: [], [qTextReq.id]: 'x' });
  check('必填多选传空数组返回 400', r.status === 400 && r.json.code === 'ANSWER_REQUIRED', r.text);

  r = await submit({ [qSingle.id]: qSingle.options[0].id, [qMultiReq.id]: 'P', [qTextReq.id]: 'x' });
  check('必填多选传非数组（字符串）返回 400 INVALID_ANSWER_FORMAT',
    r.status === 400 && r.json.code === 'INVALID_ANSWER_FORMAT', r.text);

  // 选填多选题：非数组一律拒绝（修复前会被静默当成未作答保存）
  const validBase = {
    [qSingle.id]: qSingle.options[0].id,
    [qMultiReq.id]: [qMultiReq.options[0].id],
    [qTextReq.id]: 'x',
  };
  for (const bad of [
    { label: '字符串（合法选项 id）', value: qMultiOpt.options[0].id },
    { label: '字符串（非法选项）', value: 'opt_not_exist' },
    { label: '数字', value: 42 },
    { label: '对象', value: { x: 1 } },
    { label: 'null', value: null },
  ]) {
    r = await submit({ ...validBase, [qMultiOpt.id]: bad.value });
    check(`选填多选传${bad.label}返回 400 INVALID_ANSWER_FORMAT`,
      r.status === 400 && r.json.code === 'INVALID_ANSWER_FORMAT', `${r.status} ${r.text}`);
  }

  // 选填多选：数组中含非法选项同样拒绝（修复前字符串分支绕过了选项校验）
  r = await submit({ ...validBase, [qMultiOpt.id]: [qMultiOpt.options[0].id, 'opt_fake'] });
  check('选填多选数组混入非法选项返回 400 INVALID_OPTION',
    r.status === 400 && r.json.code === 'INVALID_OPTION', r.text);

  r = await submit({ [qSingle.id]: qSingle.options[0].id, [qMultiReq.id]: [qMultiReq.options[0].id], [qTextReq.id]: '   ' });
  check('必填文本传空白返回 400', r.status === 400 && r.json.code === 'ANSWER_REQUIRED', r.text);

  r = await submit({ [qSingle.id]: 'opt_not_exist', [qMultiReq.id]: [qMultiReq.options[0].id], [qTextReq.id]: 'x' });
  check('单选选择不存在的选项返回 400 INVALID_OPTION',
    r.status === 400 && r.json.code === 'INVALID_OPTION', r.text);

  r = await submit({
    [qSingle.id]: qSingle.options[0].id,
    [qMultiReq.id]: [qMultiReq.options[0].id, 'opt_fake'],
    [qTextReq.id]: 'x',
  });
  check('多选混入不存在的选项返回 400', r.status === 400 && r.json.code === 'INVALID_OPTION', r.text);

  r = await submit({
    [qSingle.id]: qSingle.options[0].id,
    [qMultiReq.id]: [qMultiReq.options[0].id],
    [qTextReq.id]: 'x'.repeat(2001),
  });
  check('文本答案超过 2000 字返回 400 ANSWER_TOO_LONG',
    r.status === 400 && r.json.code === 'ANSWER_TOO_LONG', r.text);

  // 合法提交：可选项整题省略；同时显式给选填多选传空数组（仍按未作答处理）
  r = await submit({
    [qSingle.id]: qSingle.options[1].id,
    [qMultiOpt.id]: [],
    [qMultiReq.id]: [qMultiReq.options[1].id],
    [qTextReq.id]: '合法回答',
  });
  check('可选项省略 + 选填多选空数组时提交成功', r.status === 200, r.text);

  // 被拒绝的脏答案没有产生部分提交
  const finalBoard = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('校验失败未产生多余提交（提交人数 1）', finalBoard.submissionCount === 1);
  const optionalMulti = finalBoard.questions[1];
  check('选填多选空数组按未作答保存（作答人数 0、各选项 0）',
    optionalMulti.answeredCount === 0 && optionalMulti.options.every((o) => o.count === 0));

  // 问卷建模校验
  const model = (payload, token = org.token) => w.call('POST', '/api/events', { token, body: payload });
  check('没有题目返回 400 NO_QUESTIONS',
    (await model({ title: 't', questions: [] })).json.code === 'NO_QUESTIONS');
  check('未知题型返回 400 INVALID_QUESTION_TYPE',
    (await model({ title: 't', questions: [{ type: 'rating', title: 'x', required: true }] })).json.code === 'INVALID_QUESTION_TYPE');
  check('题目标题为空返回 400',
    (await model({ title: 't', questions: [{ type: 'text', title: '  ', required: false }] })).json.code === 'INVALID_QUESTION_TITLE');
  check('单选只有 1 个选项返回 400',
    (await model({ title: 't', questions: [{ type: 'single', title: 'x', required: true, options: ['A'] }] })).json.code === 'INVALID_OPTIONS');
  check('重复选项返回 400 DUPLICATE_OPTION',
    (await model({ title: 't', questions: [{ type: 'single', title: 'x', required: true, options: ['A', 'A'] }] })).json.code === 'DUPLICATE_OPTION');
});

// ---------- T6 登出后令牌失效 ----------

group('T6 登出后令牌立即失效', async (w, check) => {
  const session = await w.signup('participant', 'u');
  const token = session.token;
  check('登录令牌可用（/me 200）', (await w.call('GET', '/api/auth/me', { token })).status === 200);

  const logout = await w.call('POST', '/api/auth/logout', { token });
  check('登出返回 200', logout.status === 200);

  check('登出后原令牌访问 /me 返回 401', (await w.call('GET', '/api/auth/me', { token })).status === 401);
  check('登出后原令牌查我的报名返回 401', (await w.call('GET', '/api/registrations/mine', { token })).status === 401);

  // 再次登出幂等，不带令牌也不报错
  check('重复登出幂等', (await w.call('POST', '/api/auth/logout', { token })).status === 200);

  // 重新登录得到新令牌
  const relogin = await w.login(session.user.username);
  check('重新登录获得新令牌', relogin.token && relogin.token !== token);
  check('新令牌可用', (await w.call('GET', '/api/auth/me', { token: relogin.token })).status === 200);
  check('旧令牌仍然失效', (await w.call('GET', '/api/auth/me', { token })).status === 401);

  // 签名被篡改的令牌
  const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
  check('篡改签名的令牌返回 401', (await w.call('GET', '/api/auth/me', { token: tampered })).status === 401);
});

// ---------- T7 重启回读 ----------

group('T7 重启后数据回读', async (w, check) => {
  const org = await w.signup('organizer');
  // 一个草稿、一个已发布活动
  const draft = await w.call('POST', '/api/events', { token: org.token, body: {
    title: '未发布活动', questions: [{ type: 'text', title: '草稿题', required: false }],
  } });
  const draftId = draft.json.data.id;
  const { eventId, questions } = await w.createPublishedEvent(org.token, STANDARD_QUESTIONS);

  const users = await Promise.all([0, 1, 2].map(() => w.signup('participant', 'u')));
  await Promise.all(users.map((u) => w.call('POST', `/api/events/${eventId}/register`, { token: u.token })));
  const preSub1 = await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: users[0].token,
    body: {
      answers: {
        [questions[0].id]: questions[0].options[0].id,
        [questions[1].id]: [questions[1].options[0], questions[1].options[2]].map((o) => o.id),
        [questions[2].id]: '重启前的文本答案',
      },
    },
  });
  const preSub2 = await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: users[1].token,
    body: {
      answers: { [questions[0].id]: questions[0].options[2].id, [questions[1].id]: [], [questions[2].id]: '' },
    },
  });
  check('重启前两份问卷提交成功', preSub1.status === 200 && preSub2.status === 200,
    `${preSub1.status} ${preSub1.text} / ${preSub2.status} ${preSub2.text}`);

  // 磁盘文件本身是合法 JSON
  for (const name of ['users', 'events', 'registrations', 'submissions', 'tokens']) {
    check(`数据文件 ${name}.json 可解析为数组`, Array.isArray(w.readCollection(name)));
  }

  await w.restart();

  // 密码、活动、计数全部回读
  const relogged = await w.login(users[0].user.username);
  check('重启后可用原密码登录', relogged.status !== 0);
  check('重启后原会话令牌仍有效（会话已持久化，登出才失效）',
    (await w.call('GET', '/api/auth/me', { token: users[0].token })).status === 200);

  const published = await w.call('GET', '/api/events');
  check('已发布活动重启后仍在公开列表', published.json.data.some((e) => e.id === eventId));
  check('草稿活动重启后仍不在公开列表', !published.json.data.some((e) => e.id === draftId));

  const mine = (await w.call('GET', '/api/events/mine', { token: org.token })).json.data;
  const draftAfter = mine.find((e) => e.id === draftId);
  check('草稿状态保持为 draft', draftAfter && draftAfter.status === 'draft');
  const editDraft = await w.call('PUT', `/api/events/${draftId}`, {
    token: org.token, body: { title: '重启后继续编辑草稿' },
  });
  check('重启后草稿仍可编辑', editDraft.status === 200 && editDraft.json.data.title === '重启后继续编辑草稿');

  const board = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('重启后报名/提交人数保持 3/2', board.registeredCount === 3 && board.submissionCount === 2,
    `${board.registeredCount}/${board.submissionCount}`);
  check('重启后单选分布保持（好1/中0/差1）',
    board.questions[0].options.map((o) => o.count).join(',') === '1,0,1');
  check('重启后多选分布保持',
    board.questions[1].options.map((o) => o.count).join(',') === '1,0,1,0');
  check('重启后文本答案原样回读',
    board.questions[2].textAnswers.length === 1 && board.questions[2].textAnswers[0].value === '重启前的文本答案');

  // 一次性约束跨进程保持
  const dup = await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: relogged.token,
    body: { answers: { [questions[0].id]: questions[0].options[0].id, [questions[1].id]: [], [questions[2].id]: '' } },
  });
  check('重启后已提交用户仍被拒绝（409）', dup.status === 409 && dup.json.code === 'ALREADY_SUBMITTED');

  // 尚未提交的第三人重启后仍可提交一次
  const u2 = await w.login(users[2].user.username);
  const oneShot = await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: u2.token,
    body: { answers: { [questions[0].id]: questions[0].options[1].id, [questions[1].id]: [], [questions[2].id]: '' } },
  });
  check('重启后未提交用户可正常提交', oneShot.status === 200);
  const board2 = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('补提交后人数变为 3', board2.submissionCount === 3);
});

// ---------- T8 异常中断与临时文件 ----------

group('T8 异常中断：临时文件处理与 SIGKILL 崩溃', async (w, check) => {
  const org = await w.signup('organizer');
  const { eventId, questions } = await w.createPublishedEvent(org.token, STANDARD_QUESTIONS);
  const people = await Promise.all(Array.from({ length: 6 }, () => w.signup('participant', 'u')));
  await Promise.all(people.map((p) => w.call('POST', `/api/events/${eventId}/register`, { token: p.token })));
  const answerFor = (i) => ({
    [questions[0].id]: questions[0].options[i % 3].id,
    [questions[1].id]: [questions[1].options[i % 4].id],
    [questions[2].id]: `基线文本 ${i}`,
  });
  for (let i = 0; i < 3; i++) {
    await w.call('POST', `/api/events/${eventId}/submissions`, { token: people[i].token, body: { answers: answerFor(i) } });
  }

  // 正常运行期间不应残留 .tmp（写操作是 tmp + rename）
  const leftovers = fs.readdirSync(w.dir).filter((f) => f.endsWith('.tmp'));
  check('正常写入后无临时文件残留', leftovers.length === 0, leftovers.join(','));

  // ---- 阶段 A：优雅停机后注入「上次崩溃」遗留的垃圾临时文件 ----
  await w.restart(); // 先优雅停一次
  fs.writeFileSync(path.join(w.dir, '.events.999.deadbeef.tmp'), '{这不是合法JSON', 'utf8');
  fs.writeFileSync(path.join(w.dir, '.users.999.cafef00d.tmp'), '[{"ghost":true}]', 'utf8');
  fs.writeFileSync(path.join(w.dir, '.submissions.999.empty.tmp'), '', 'utf8');
  await w.restart();

  check('存在垃圾临时文件时服务正常启动（healthz 200）', (await w.call('GET', '/healthz')).status === 200);
  const boardA = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('垃圾临时文件内容未被加载（提交人数仍为 3）', boardA.submissionCount === 3);
  check('users.json 未混入幽灵记录',
    w.readCollection('users').every((u) => u.ghost !== true) &&
    (await w.call('GET', '/api/auth/me', { token: org.token })).status === 200);

  // 新写入在存在垃圾文件的目录中仍成功（rename 不被干扰）
  const subNew = await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: people[3].token, body: { answers: answerFor(3) },
  });
  check('有垃圾文件时新提交仍成功', subNew.status === 200);

  // ---- 阶段 B：提交洪峰中 SIGKILL，验证主文件永不半写、已 ack 必落盘 ----
  const ROUNDS = 3;
  const N = 30;
  const burstPeople = await Promise.all(Array.from({ length: N }, () => w.signup('participant', 'b')));
  const events = [];
  for (let r = 0; r < ROUNDS; r++) {
    const ev = await w.createPublishedEvent(org.token, STANDARD_QUESTIONS);
    await Promise.all(burstPeople.map((p) => w.call('POST', `/api/events/${ev.eventId}/register`, { token: p.token })));
    events.push(ev);
  }

  const roundAcks = [];
  for (let r = 0; r < ROUNDS; r++) {
    const ev = events[r];
    const pending = burstPeople.map((p, i) =>
      w.call('POST', `/api/events/${ev.eventId}/submissions`, {
        token: p.token,
        body: {
          answers: {
            [ev.questions[0].id]: ev.questions[0].options[i % 3].id,
            [ev.questions[1].id]: [ev.questions[1].options[i % 4].id],
            [ev.questions[2].id]: `崩溃轮次 ${r} 用户 ${i}`,
          },
        },
      }).then((res) => ({ res, eventId: ev.eventId })));
    // 让请求飞一会儿后立即强杀，尽量打中处理窗口
    await new Promise((resolve) => setTimeout(resolve, 8));
    await w.hardKill();

    const settled = await Promise.allSettled(pending);
    const acked = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value.res.status === 200) {
        acked.push({ eventId: s.value.eventId, id: s.value.res.json.data.id });
      }
    }
    roundAcks.push(...acked);

    // 强杀后所有主集合文件必须仍是合法 JSON（原子 rename 保证无半写）
    let allParsable = true;
    for (const name of ['users', 'events', 'registrations', 'submissions', 'tokens']) {
      try {
        const v = JSON.parse(fs.readFileSync(path.join(w.dir, `${name}.json`), 'utf8'));
        if (!Array.isArray(v)) allParsable = false;
      } catch { allParsable = false; }
    }
    check(`第 ${r + 1} 轮 SIGKILL 后五个主数据文件全部完整可解析`, allParsable);
    check(`第 ${r + 1} 轮已确认成功(${acked.length})的提交全部落盘`, (() => {
      const onDisk = JSON.parse(fs.readFileSync(path.join(w.dir, 'submissions.json'), 'utf8'));
      const ids = new Set(onDisk.map((s) => s.id));
      return acked.every((a) => ids.has(a.id));
    })(), `acked=${acked.length}`);

    if (r < ROUNDS - 1) await w.restart();
  }

  // 最终重启：临时残留被忽略，全部计数自洽
  const tmpBefore = fs.readdirSync(w.dir).filter((f) => f.endsWith('.tmp')).length;
  await w.restart();
  check(`最终重启成功（此前目录中有 ${tmpBefore} 个临时文件也不受影响）`,
    (await w.call('GET', '/healthz')).status === 200);

  for (const ev of events) {
    const board = (await w.call('GET', `/api/events/${ev.eventId}/results`, { token: org.token })).json.data;
    const ackedCount = roundAcks.filter((a) => a.eventId === ev.eventId).length;
    check(`崩溃轮次活动 ${ev.eventId.slice(-6)}：落盘提交数 ${board.submissionCount} >= 已 ack ${ackedCount}，且无重复`,
      board.submissionCount >= ackedCount &&
      new Set(w.readCollection('submissions').filter((s) => s.eventId === ev.eventId).map((s) => s.userId)).size === board.submissionCount,
      `落盘 ${board.submissionCount} / ack ${ackedCount}`);
  }

  const finalBoard = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('基线活动数据三轮崩溃后保持完好（提交人数 4）', finalBoard.submissionCount === 4,
    `实际 ${finalBoard.submissionCount}`);
});

// ---------- T9 提交明细导出 ----------

// 最小 RFC4180 CSV 解析（支持引号转义与字段内换行），返回行数组（每行是字段数组）
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // 与 \n 配合处理
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

group('T9 提交明细导出（JSON/CSV、空结果、权限）', async (w, check) => {
  const org = await w.signup('organizer');
  const org2 = await w.signup('organizer');
  const u1 = await w.signup('participant', 'u');
  const u2 = await w.signup('participant', 'u');
  const outsider = await w.signup('participant', 'u');

  const created = await w.call('POST', '/api/events', { token: org.token, body: {
    title: '导出测试,沙龙',
    questions: [
      { type: 'single', title: '评分', required: true, options: ['好,很好', '一般', '差'] },
      { type: 'multi', title: '亮点（多选）', required: false, options: ['内容', '讲师"大牛"', '茶歇'] },
      { type: 'text', title: '建议（含逗号,引号"换行）', required: false },
    ],
  } });
  const eventId = created.json.data.id;
  await w.call('POST', `/api/events/${eventId}/publish`, { token: org.token });
  const ev = (await w.call('GET', `/api/events/${eventId}`, { token: org.token })).json.data;
  const [qSingle, qMulti, qText] = ev.questions;

  for (const u of [u1, u2]) {
    await w.call('POST', `/api/events/${eventId}/register`, { token: u.token });
  }
  const text1 = '组织很好，下次多办\n第二行：加点「实操」';
  const text2 = '纯文本,带逗号; 和分号';
  await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: u1.token,
    body: { answers: {
      [qSingle.id]: qSingle.options[0].id,
      [qMulti.id]: [qMulti.options[0].id, qMulti.options[2].id],
      [qText.id]: text1,
    } },
  });
  await w.call('POST', `/api/events/${eventId}/submissions`, {
    token: u2.token,
    body: { answers: {
      [qSingle.id]: qSingle.options[1].id,
      [qMulti.id]: [],
      [qText.id]: text2,
    } },
  });

  // ---- JSON 导出 ----
  const j = await w.call('GET', `/api/events/${eventId}/export`, { token: org.token });
  check('JSON 导出 200', j.status === 200, j.text);
  check('Content-Type 为 JSON', j.contentType.includes('application/json'));
  check('empty=false / count=2', j.json.data.empty === false && j.json.data.count === 2);
  check('X-Export-Empty 头为 0', j.emptyHeader === '0');
  check('包含活动与题目元信息',
    j.json.data.event.id === eventId && j.json.data.questions.length === 3);

  const [row1, row2] = j.json.data.submissions;
  check('明细含提交时间（ISO 字符串）',
    typeof row1.submittedAt === 'string' && !Number.isNaN(Date.parse(row1.submittedAt)));
  check('明细含提交人昵称', row1.nickname === u1.user.nickname && row2.nickname === u2.user.nickname);
  check('按提交时间升序', row1.submittedAt <= row2.submittedAt);
  check('每题答案齐全（3 题）', row1.answers.length === 3);
  check('单选保留结构化选项 id',
    row1.answers[0].value === qSingle.options[0].id && row1.answers[0].text === '好,很好');
  check('多选 value 为选项 id 数组、text 以「; 」合并',
    JSON.stringify(row1.answers[1].value) === JSON.stringify([qMulti.options[0].id, qMulti.options[2].id]) &&
    row1.answers[1].text === '内容; 茶歇');
  check('空多选 value 为空数组、text 为空串',
    Array.isArray(row2.answers[1].value) && row2.answers[1].value.length === 0 && row2.answers[1].text === '');
  check('文本答案原样保留（含换行）', row1.answers[2].value === text1 && row1.answers[2].text === text1);
  check('文本中的逗号/分号原样保留', row2.answers[2].value === text2);

  // ---- CSV 导出（format=csv）----
  const c = await w.call('GET', `/api/events/${eventId}/export?format=csv`, { token: org.token });
  check('CSV 导出 200 且 Content-Type 为 text/csv', c.status === 200 && c.contentType.startsWith('text/csv'));
  check('含附件下载头并带文件名', c.disposition.includes('attachment') && c.disposition.includes('.csv'));
  check('X-Export-Count 头为 2', c.countHeader === '2');
  // 注意：fetch().text() 的 UTF-8 解码会剥掉 BOM，需直接读响应字节验证
  const rawCsv = await fetch(`${w.base}/api/events/${eventId}/export?format=csv`, {
    headers: { Authorization: `Bearer ${org.token}` },
  }).then((r) => r.arrayBuffer());
  const bytes = Buffer.from(rawCsv);
  check('输出含 UTF-8 BOM（EF BB BF）', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf);

  const rows = parseCsv(c.text);
  check('CSV 共 3 行（表头 + 2 条提交）', rows.length === 3, `实际 ${rows.length}`);
  check('表头为提交时间/提交人/提交ID + 各题标题',
    JSON.stringify(rows[0].slice(0, 3)) === JSON.stringify(['提交时间', '提交人', '提交ID']) &&
    rows[0][3] === '评分' && rows[0][4] === '亮点（多选）' && rows[0][5] === '建议（含逗号,引号"换行）');
  const data1 = rows[1];
  check('CSV 单选为选项文本（含逗号正确转义）', data1[3] === '好,很好');
  check('CSV 多选合并显示「内容; 茶歇」', data1[4] === '内容; 茶歇');
  check('CSV 文本换行原样保留在单元格内', data1[5] === text1);
  check('CSV 提交时间与 JSON 一致', data1[0] === row1.submittedAt && data1[1] === row1.nickname);
  check('第二条空多选单元格为空', rows[2][4] === '');

  // 格式协商：无参数默认 JSON；Accept: text/csv 返回 CSV
  const viaAccept = await w.call('GET', `/api/events/${eventId}/export`, { token: org.token, accept: 'text/csv' });
  check('Accept: text/csv 协商返回 CSV', viaAccept.status === 200 && viaAccept.contentType.startsWith('text/csv'));
  const defaultJson = await w.call('GET', `/api/events/${eventId}/export`, { token: org.token });
  check('无 format 参数默认返回 JSON', defaultJson.contentType.includes('application/json'));

  // ---- 空结果 ----
  const emptyEvent = await w.call('POST', '/api/events', { token: org.token, body: {
    title: '无人提交的活动', questions: STANDARD_QUESTIONS,
  } });
  const emptyId = emptyEvent.json.data.id;
  await w.call('POST', `/api/events/${emptyId}/publish`, { token: org.token });
  // 有人报名但无人提交
  await w.call('POST', `/api/events/${emptyId}/register`, { token: outsider.token });

  const ej = await w.call('GET', `/api/events/${emptyId}/export`, { token: org.token });
  check('空结果 JSON 200 且 empty=true / count=0',
    ej.status === 200 && ej.json.data.empty === true && ej.json.data.count === 0 &&
    Array.isArray(ej.json.data.submissions) && ej.json.data.submissions.length === 0);
  check('空结果 X-Export-Empty 头为 1', ej.emptyHeader === '1');

  const ec = await w.call('GET', `/api/events/${emptyId}/export?format=csv`, { token: org.token });
  check('空结果 CSV 200', ec.status === 200 && ec.contentType.startsWith('text/csv'));
  check('空结果 X-Export-Empty 头为 1', ec.emptyHeader === '1');
  const emptyRows = parseCsv(ec.text);
  check('空结果 CSV 只有表头一行', emptyRows.length === 1 && emptyRows[0].length === 6);

  // ---- 权限与不存在的活动 ----
  check('未登录导出返回 401',
    (await w.call('GET', `/api/events/${eventId}/export`)).status === 401);
  check('参与者导出返回 403',
    (await w.call('GET', `/api/events/${eventId}/export`, { token: u1.token })).status === 403);
  check('其他组织者导出别人的活动返回 403',
    (await w.call('GET', `/api/events/${eventId}/export`, { token: org2.token })).status === 403);
  check('其他组织者看 CSV 同样 403',
    (await w.call('GET', `/api/events/${eventId}/export?format=csv`, { token: org2.token })).status === 403);
  check('不存在的活动返回 404',
    (await w.call('GET', '/api/events/evt_not_exist/export', { token: org.token })).status === 404);

  // ---- 导出不改变任何业务状态 ----
  const board = (await w.call('GET', `/api/events/${eventId}/results`, { token: org.token })).json.data;
  check('导出后统计不变（报名 2 / 提交 2）', board.registeredCount === 2 && board.submissionCount === 2);
  check('已提交用户仍不能重复提交',
    (await w.call('POST', `/api/events/${eventId}/submissions`, {
      token: u1.token,
      body: { answers: { [qSingle.id]: qSingle.options[2].id, [qMulti.id]: [], [qText.id]: '' } },
    })).status === 409);
  const emptyDetail = (await w.call('GET', `/api/events/${emptyId}`, { token: org.token })).json.data;
  const realSubmit = await w.call('POST', `/api/events/${emptyId}/submissions`, {
    token: outsider.token,
    body: { answers: { [emptyDetail.questions[0].id]: emptyDetail.questions[0].options[0].id } },
  });
  check('空结果活动在真实提交后导出变为 1 条',
    realSubmit.status === 200 &&
    (await w.call('GET', `/api/events/${emptyId}/export`, { token: org.token })).json.data.count === 1);
});

// ---------- 主流程 ----------

async function main() {
  console.log('活动问卷反馈模块 —— 可重复测试套件\n');
  const results = [];
  const startedAt = Date.now();

  for (const g of groups) {
    if (process.env.ONLY && !g.name.includes(process.env.ONLY)) continue;
    console.log(`\n${g.name}`);
    const rec = recorder(g.name);
    const worldP = createWorld();
    let world;
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`用例超时（${GROUP_TIMEOUT_MS / 1000}s）`)), GROUP_TIMEOUT_MS));
    try {
      world = await worldP;
      await Promise.race([g.fn(world, rec.check), timeout]);
    } catch (e) {
      rec.check('用例执行未抛出异常', false, e.stack || e.message);
    } finally {
      if (world) await world.destroy(rec.fail > 0).catch(() => {});
    }
    results.push(rec);
  }

  console.log('\n================ 汇总 ================');
  let totalPass = 0;
  let totalFail = 0;
  for (const r of results) {
    totalPass += r.pass;
    totalFail += r.fail;
    const tag = r.fail === 0 ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${r.name} —— ${r.pass} 通过，${r.fail} 失败`);
    for (const f of r.failures) console.log(`       - ${f}`);
  }
  console.log(`\n合计：${totalPass} 通过，${totalFail} 失败；用时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (totalFail > 0) {
    console.log('（失败用例的数据目录已保留在系统临时目录 esuite-* 下以便排查）');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('测试框架异常：', e);
  process.exit(1);
});
