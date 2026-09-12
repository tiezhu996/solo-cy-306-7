'use strict';

// 端到端冒烟测试：启动一个使用临时数据目录的服务实例，走完整接口流程，
// 覆盖：建问卷 -> 未发布拒绝报名/提交 -> 发布 -> 未报名拒绝提交 -> 报名 ->
// 必填校验/非法选项 -> 正常提交 -> 重复提交拒绝 -> 结果统计回读。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3911;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'event-survey-test-'));

let passed = 0;
let failed = 0;

function assert(cond, message) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

async function call(method, url, { token, body, expectStatus = 200 } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  assert(res.status === expectStatus, `${method} ${url} -> HTTP ${res.status}（期望 ${expectStatus}）${res.status !== expectStatus ? `：${json.message}` : ''}`);
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(server, retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch { /* 尚未启动 */ }
    if (server.exitCode !== null) throw new Error('服务进程提前退出');
    await sleep(100);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: 'ignore',
  });

  try {
    await waitReady(server);

    console.log('\n[1] 注册账号');
    const org = (await call('POST', '/api/auth/register', {
      body: { username: 'orgtest', password: 'Org@1234', nickname: '测试组织者', role: 'organizer' },
    })).json.data;
    const alice = (await call('POST', '/api/auth/register', {
      body: { username: 'alicetest', password: 'User@1234', nickname: '测试爱丽丝', role: 'participant' },
    })).json.data;
    const bob = (await call('POST', '/api/auth/register', {
      body: { username: 'bobtest', password: 'User@1234', nickname: '测试鲍勃', role: 'participant' },
    })).json.data;
    assert(org.user.role === 'organizer', '组织者注册成功');
    assert(alice.user.role === 'participant', '参与者注册成功');

    console.log('\n[2] 登录校验');
    const badLogin = await call('POST', '/api/auth/login', { body: { username: 'orgtest', password: 'wrong' }, expectStatus: 401 });
    assert(badLogin.json.code === 'BAD_CREDENTIALS', '错误密码被拒绝（401）');
    const orgLogin = (await call('POST', '/api/auth/login', { body: { username: 'orgtest', password: 'Org@1234' } })).json.data;
    const orgToken = orgLogin.token;

    console.log('\n[3] 创建活动与问卷（含三种题型 + 必填）');
    const created = await call('POST', '/api/events', {
      token: orgToken,
      body: {
        title: '冒烟测试沙龙',
        description: '端到端测试用活动',
        questions: [
          { type: 'single', title: '满意度？', required: true, options: ['满意', '一般', '不满意'] },
          { type: 'multi', title: '感兴趣的主题（多选）', required: false, options: ['前端', '后端', 'AI'] },
          { type: 'text', title: '建议', required: false },
        ],
      },
    });
    const eventId = created.json.data.id;
    assert(eventId, '活动创建成功，返回 id');
    assert(created.json.data.status === 'draft', '新活动为草稿状态');

    const badQ = await call('POST', '/api/events', {
      token: orgToken,
      body: { title: '坏问卷', questions: [{ type: 'single', title: '只有一个选项', options: ['A'] }] },
      expectStatus: 400,
    });
    assert(badQ.json.code === 'INVALID_OPTIONS', '单选题少于 2 个选项被拒绝');

    console.log('\n[4] 权限：参与者不能建活动');
    const forbidden = await call('POST', '/api/events', {
      token: alice.token,
      body: { title: '越权', questions: [{ type: 'text', title: 't', required: false }] },
      expectStatus: 403,
    });
    assert(forbidden.json.code === 'FORBIDDEN', '参与者调用组织者接口被拒绝（403）');

    console.log('\n[5] 草稿期：问卷未开放');
    const draftNotListed = await call('GET', '/api/events');
    assert(!draftNotListed.json.data.some((e) => e.id === eventId), '草稿不出现在公开活动列表');
    const earlyRegister = await call('POST', `/api/events/${eventId}/register`, { token: alice.token, expectStatus: 409 });
    assert(earlyRegister.json.code === 'EVENT_NOT_PUBLISHED', '草稿活动报名被拒绝（409）');
    const earlySubmit = await call('POST', `/api/events/${eventId}/submissions`, { token: alice.token, body: { answers: {} }, expectStatus: 409 });
    assert(earlySubmit.json.code === 'SURVEY_NOT_OPEN', '草稿活动提交问卷被拒绝（409）');

    console.log('\n[6] 发布活动');
    const published = await call('POST', `/api/events/${eventId}/publish`, { token: orgToken });
    assert(published.json.data.status === 'published', '活动状态变为 published');
    const nowListed = await call('GET', '/api/events');
    assert(nowListed.json.data.some((e) => e.id === eventId), '发布后出现在公开活动列表');

    const editLocked = await call('PUT', `/api/events/${eventId}`, {
      token: orgToken,
      body: { title: '发布后改名' },
      expectStatus: 409,
    });
    assert(editLocked.json.code === 'EVENT_ALREADY_PUBLISHED', '发布后编辑问卷被拒绝（题目锁定）');

    console.log('\n[7] 未报名先提交 -> 拒绝');
    const notRegistered = await call('POST', `/api/events/${eventId}/submissions`, {
      token: bob.token,
      body: { answers: {} },
      expectStatus: 403,
    });
    assert(notRegistered.json.code === 'NOT_REGISTERED', '未报名用户提交被拒绝（403）');

    console.log('\n[8] 报名：成功 + 重复报名拒绝');
    const reg = await call('POST', `/api/events/${eventId}/register`, { token: alice.token });
    assert(reg.json.data.eventId === eventId, 'alice 报名成功');
    const dupReg = await call('POST', `/api/events/${eventId}/register`, { token: alice.token, expectStatus: 409 });
    assert(dupReg.json.code === 'ALREADY_REGISTERED', '重复报名被拒绝（409）');

    console.log('\n[9] 提交校验：必填缺失 / 非法选项');
    const missingRequired = await call('POST', `/api/events/${eventId}/submissions`, {
      token: alice.token,
      body: { answers: {} },
      expectStatus: 400,
    });
    assert(missingRequired.json.code === 'ANSWER_REQUIRED', '必填题未作答被拒绝（400）');

    const ev = (await call('GET', `/api/events/${eventId}`, { token: alice.token })).json.data;
    const qSingle = ev.questions[0];
    const qMulti = ev.questions[1];
    const qText = ev.questions[2];
    const bogus = await call('POST', `/api/events/${eventId}/submissions`, {
      token: alice.token,
      body: { answers: { [qSingle.id]: 'opt_does_not_exist', [qMulti.id]: [], [qText.id]: '' } },
      expectStatus: 400,
    });
    assert(bogus.json.code === 'INVALID_OPTION', '选择不存在的选项被拒绝（400）');

    console.log('\n[10] 正常提交 + 重复提交拒绝');
    const submit1 = await call('POST', `/api/events/${eventId}/submissions`, {
      token: alice.token,
      body: {
        answers: {
          [qSingle.id]: qSingle.options[0].id,
          [qMulti.id]: [qMulti.options[0].id, qMulti.options[2].id],
          [qText.id]: '活动组织得很好，建议增加实操环节。',
        },
      },
    });
    assert(submit1.json.data.id, 'alice 提交成功，返回提交 id');

    const submitAgain = await call('POST', `/api/events/${eventId}/submissions`, {
      token: alice.token,
      body: {
        answers: { [qSingle.id]: qSingle.options[1].id, [qMulti.id]: [], [qText.id]: '' },
      },
      expectStatus: 409,
    });
    assert(submitAgain.json.code === 'ALREADY_SUBMITTED', '同一用户重复提交被拒绝（409）');

    // bob 报名后提交第二份，验证聚合计数
    await call('POST', `/api/events/${eventId}/register`, { token: bob.token });
    await call('POST', `/api/events/${eventId}/submissions`, {
      token: bob.token,
      body: {
        answers: {
          [qSingle.id]: qSingle.options[0].id,
          [qMulti.id]: [qMulti.options[0].id],
          [qText.id]: '',
        },
      },
    });

    console.log('\n[11] 结果看板回读');
    const results = (await call('GET', `/api/events/${eventId}/results`, { token: orgToken })).json.data;
    assert(results.registeredCount === 2, `报名人数 = 2（实际 ${results.registeredCount}）`);
    assert(results.submissionCount === 2, `提交人数 = 2（实际 ${results.submissionCount}）`);
    const rSingle = results.questions[0];
    assert(rSingle.options[0].count === 2, `单选题「满意」2 人（实际 ${rSingle.options[0].count}）`);
    assert(rSingle.options[1].count === 0, '单选题「一般」0 人');
    const rMulti = results.questions[1];
    assert(rMulti.options[0].count === 2, '多选题「前端」2 人');
    assert(rMulti.options[2].count === 1, '多选题「AI」1 人');
    const rText = results.questions[2];
    assert(rText.textAnswers.length === 1, `文本题答案 1 条（实际 ${rText.textAnswers.length}）`);
    assert(rText.textAnswers[0].nickname === '测试爱丽丝', '文本答案带提交者昵称');

    const resultsForbidden = await call('GET', `/api/events/${eventId}/results`, { token: alice.token, expectStatus: 403 });
    assert(resultsForbidden.status === 403, '参与者不能查看结果看板');

    console.log('\n[12] 数据落盘回读：重启服务后数据仍在');
    server.kill();
    await sleep(300);
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
    assert(files.includes('events.json') && files.includes('submissions.json'), 'JSON 数据文件已写入磁盘');
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'submissions.json'), 'utf8'));
    assert(onDisk.length === 2, `磁盘上 submissions.json 有 2 条记录（实际 ${onDisk.length}）`);

    const server2 = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR },
      stdio: 'ignore',
    });
    await waitReady(server2);
    const orgAgain = (await call('POST', '/api/auth/login', { body: { username: 'orgtest', password: 'Org@1234' } })).json.data;
    const afterRestart = (await call('GET', `/api/events/${eventId}/results`, { token: orgAgain.token })).json.data;
    assert(afterRestart.submissionCount === 2, '重启后从磁盘回读，提交人数仍为 2');
    server2.kill();
  } finally {
    server.kill();
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
