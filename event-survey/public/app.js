'use strict';

/* 活动问卷反馈系统 —— 前端单页应用（原生 JS，无构建依赖）
 * 路由：hash 路由；鉴权：localStorage 存 token；所有接口走 /api。
 */

const app = document.getElementById('app');
const nav = document.getElementById('nav');

// ---------- 基础工具 ----------

const state = {
  get token() { return localStorage.getItem('token'); },
  set token(v) { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); },
  get user() {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  },
  set user(v) { v ? localStorage.setItem('user', JSON.stringify(v)) : localStorage.removeItem('user'); },
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, type = '') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 2600);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON 响应 */ }
  if (!res.ok || (json && json.code !== 0)) {
    const message = json?.message || `请求失败（${res.status}）`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return json.data;
}

function go(hash) { window.location.hash = hash; }

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-link]');
  if (link) {
    e.preventDefault();
    go(link.getAttribute('data-link'));
  }
});

function requireRole(role) {
  const user = state.user;
  if (!user) { go('#/login'); return null; }
  if (role && user.role !== role) { toast('当前账号无权访问该页面', 'error'); go('#/events'); return null; }
  return user;
}

// ---------- 顶部导航 ----------

function renderNav() {
  const user = state.user;
  if (!user) {
    nav.innerHTML = `<a data-link="#/events">活动列表</a>
      <a data-link="#/login">登录</a>
      <a data-link="#/register">注册</a>`;
    return;
  }
  const links = [`<span class="who">${esc(user.nickname)}（${user.role === 'organizer' ? '组织者' : '参与者'}）</span>`];
  if (user.role === 'organizer') {
    links.push(`<a data-link="#/organizer">我的活动</a>`);
  } else {
    links.push(`<a data-link="#/events">活动列表</a>`);
    links.push(`<a data-link="#/my">我的报名</a>`);
  }
  links.push(`<a href="#" id="logout-btn">登出</a>`);
  nav.innerHTML = links.join('');
  document.getElementById('logout-btn').onclick = async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/auth/logout'); } catch { /* 忽略登出接口失败 */ }
    state.token = null;
    state.user = null;
    go('#/events');
  };
}

// ---------- 页面：登录 / 注册 ----------

function pageLogin() {
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h2>登录</h2>
      <label class="field">用户名<input type="text" id="username" placeholder="organizer / alice" /></label>
      <label class="field">密码<input type="password" id="password" placeholder="请输入密码" /></label>
      <button id="btn-login">登录</button>
      <div class="error-text" id="err"></div>
      <p class="muted" style="margin-top:14px;">
        演示账号：组织者 organizer / Org@1234；参与者 alice / User@1234<br />
        还没有账号？<a data-link="#/register">立即注册</a>
      </p>
    </div>`;
  document.getElementById('btn-login').onclick = async () => {
    try {
      const data = await api('POST', '/api/auth/login', {
        username: document.getElementById('username').value,
        password: document.getElementById('password').value,
      });
      state.token = data.token;
      state.user = data.user;
      toast('登录成功', 'success');
      go(data.user.role === 'organizer' ? '#/organizer' : '#/events');
    } catch (e) {
      document.getElementById('err').textContent = e.message;
    }
  };
}

function pageRegister() {
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto;">
      <h2>注册</h2>
      <label class="field">用户名（3-20 位字母/数字/下划线）<input type="text" id="username" /></label>
      <label class="field">昵称<input type="text" id="nickname" /></label>
      <label class="field">密码（至少 6 位）<input type="password" id="password" /></label>
      <label class="field">身份
        <select id="role">
          <option value="participant">参与者（报名活动、填写问卷）</option>
          <option value="organizer">组织者（创建活动与问卷）</option>
        </select>
      </label>
      <button id="btn-register">注册并登录</button>
      <div class="error-text" id="err"></div>
    </div>`;
  document.getElementById('btn-register').onclick = async () => {
    try {
      const data = await api('POST', '/api/auth/register', {
        username: document.getElementById('username').value,
        nickname: document.getElementById('nickname').value,
        password: document.getElementById('password').value,
        role: document.getElementById('role').value,
      });
      state.token = data.token;
      state.user = data.user;
      toast('注册成功，已自动登录', 'success');
      go(data.user.role === 'organizer' ? '#/organizer' : '#/events');
    } catch (e) {
      document.getElementById('err').textContent = e.message;
    }
  };
}

// ---------- 页面：已发布活动列表 ----------

async function pageEvents() {
  app.innerHTML = `<div class="card"><h2>已发布活动</h2><div id="list" class="muted">加载中…</div></div>`;
  const events = await api('GET', '/api/events');
  const user = state.user;
  if (!events.length) {
    document.getElementById('list').innerHTML = `<div class="empty">暂无已发布活动</div>`;
    return;
  }
  document.getElementById('list').outerHTML = events.map((ev) => `
    <div class="card event-item">
      <div>
        <strong>${esc(ev.title)}</strong>
        <div class="meta">组织者：${esc(ev.organizerName)} ｜ 已报名 ${ev.registeredCount} 人 ｜ 已提交问卷 ${ev.submissionCount} 份</div>
      </div>
      <div class="row">
        <a class="btn secondary small" data-link="#/events/${ev.id}">查看详情</a>
        ${user && user.role === 'participant' ? `<a class="btn small" data-link="#/events/${ev.id}/survey">填写问卷</a>` : ''}
      </div>
    </div>`).join('');
}

// ---------- 页面：活动详情（参与者） ----------

async function pageEventDetail(id) {
  const user = requireRole();
  if (!user) return;
  app.innerHTML = `<div class="card muted">加载中…</div>`;
  const ev = await api('GET', `/api/events/${id}`);
  if (user.role !== 'participant') {
    app.innerHTML = `<div class="card">
      <h2>${esc(ev.title)}</h2>
      <p class="muted">组织者账号请在「我的活动」中管理此活动。</p>
      <a class="btn" data-link="#/organizer">前往我的活动</a>
    </div>`;
    return;
  }
  const st = await api('GET', `/api/events/${id}/my-submission`);
  const statusBadge = st.submitted
    ? `<span class="badge published">已提交问卷</span>`
    : st.registered
      ? `<span class="badge info">已报名，待填写</span>`
      : `<span class="badge draft">未报名</span>`;

  let actions = '';
  if (st.eventStatus !== 'published') {
    actions = `<p class="muted">活动尚未发布，报名与问卷均未开放。</p>`;
  } else if (!st.registered) {
    actions = `<button id="btn-register">报名该活动</button>`;
  } else if (st.submitted) {
    actions = `<p class="muted">✅ 你已提交问卷，每人只能提交一次。</p>`;
  } else {
    actions = `<a class="btn" data-link="#/events/${id}/survey">去填写问卷</a>`;
  }

  app.innerHTML = `
    <div class="card">
      <div class="row"><h2 style="margin:0">${esc(ev.title)}</h2>${statusBadge}</div>
      <p class="muted">组织者：${esc(ev.organizerName)} ｜ 已报名 ${ev.registeredCount} 人 ｜ 问卷提交 ${ev.submissionCount} 份</p>
      <p>${esc(ev.description || '（无活动介绍）')}</p>
      <div class="row">${actions}</div>
      <div class="error-text" id="err"></div>
    </div>
    <div class="card">
      <h3>问卷题目（共 ${ev.questions.length} 题）</h3>
      ${ev.questions.map((q) => `
        <div class="question-block">
          <strong>${esc(q.title)}${q.required ? '<span class="req-star">*</span>' : ''}</strong>
          <div class="muted">${q.type === 'single' ? '单选题' : q.type === 'multi' ? '多选题' : '文本题'}</div>
          ${q.options ? q.options.map((o) => `<div class="muted">○ ${esc(o.label)}</div>`).join('') : '<div class="muted">自由填写文本</div>'}
        </div>`).join('')}
    </div>`;

  const btn = document.getElementById('btn-register');
  if (btn) {
    btn.onclick = async () => {
      try {
        await api('POST', `/api/events/${id}/register`);
        toast('报名成功', 'success');
        pageEventDetail(id);
      } catch (e) {
        document.getElementById('err').textContent = e.message;
      }
    };
  }
}

// ---------- 页面：填写问卷 ----------

async function pageSurvey(id) {
  const user = requireRole('participant');
  if (!user) return;
  app.innerHTML = `<div class="card muted">加载中…</div>`;

  const [ev, st] = await Promise.all([
    api('GET', `/api/events/${id}`),
    api('GET', `/api/events/${id}/my-submission`),
  ]);

  if (st.eventStatus !== 'published') {
    app.innerHTML = `<div class="card"><h2>问卷未开放</h2><p class="muted">活动尚未发布，问卷在活动发布后才会开放。</p>
      <a class="btn secondary" data-link="#/events/${id}">返回详情</a></div>`;
    return;
  }
  if (!st.registered) {
    app.innerHTML = `<div class="card"><h2>无法提交</h2><p class="muted">你还没有报名该活动，只有已报名人员可以提交问卷。</p>
      <a class="btn" data-link="#/events/${id}">先去报名</a></div>`;
    return;
  }
  if (st.submitted) {
    app.innerHTML = `<div class="card"><h2>已提交</h2><p class="muted">你已于 ${new Date(st.submittedAt).toLocaleString()} 提交过问卷，每人只能提交一次。</p>
      <a class="btn secondary" data-link="#/my">查看我的报名</a></div>`;
    return;
  }

  app.innerHTML = `
    <div class="card">
      <h2>${esc(ev.title)} · 活动反馈问卷</h2>
      <p class="muted">带 <span class="req-star">*</span> 为必填项，提交后不可修改。</p>
      <div id="questions"></div>
      <div class="row" style="margin-top:16px;">
        <button id="btn-submit">提交问卷</button>
        <a class="btn secondary" data-link="#/events/${id}">取消</a>
      </div>
      <div class="error-text" id="err"></div>
    </div>`;

  document.getElementById('questions').innerHTML = ev.questions.map((q, qi) => {
    const head = `<strong>${qi + 1}. ${esc(q.title)}${q.required ? '<span class="req-star">*</span>' : ''}</strong>
      <div class="muted">${q.type === 'single' ? '单选' : q.type === 'multi' ? '多选' : '文本'}</div>`;
    let body = '';
    if (q.type === 'text') {
      body = `<textarea id="ans-${q.id}" placeholder="请输入你的回答"></textarea>`;
    } else if (q.type === 'single') {
      body = `<div class="segmented">${q.options.map((o) => `
        <label class="opt-row"><input type="radio" name="ans-${q.id}" value="${o.id}" /> ${esc(o.label)}</label>`).join('')}</div>`;
    } else {
      body = q.options.map((o) => `
        <label class="opt-row"><input type="checkbox" name="ans-${q.id}" value="${o.id}" /> ${esc(o.label)}</label>`).join('');
    }
    return `<div class="question-block">${head}${body}</div>`;
  }).join('');

  document.getElementById('btn-submit').onclick = async () => {
    const answers = {};
    for (const q of ev.questions) {
      if (q.type === 'text') {
        answers[q.id] = document.getElementById(`ans-${q.id}`).value;
      } else if (q.type === 'single') {
        const picked = document.querySelector(`input[name="ans-${q.id}"]:checked`);
        answers[q.id] = picked ? picked.value : null;
      } else {
        answers[q.id] = [...document.querySelectorAll(`input[name="ans-${q.id}"]:checked`)].map((el) => el.value);
      }
    }
    try {
      await api('POST', `/api/events/${id}/submissions`, { answers });
      toast('问卷提交成功', 'success');
      go(`#/events/${id}`);
    } catch (e) {
      document.getElementById('err').textContent = e.message;
    }
  };
}

// ---------- 页面：我的报名（参与者） ----------

async function pageMy() {
  const user = requireRole('participant');
  if (!user) return;
  app.innerHTML = `<div class="card muted">加载中…</div>`;
  const list = await api('GET', '/api/registrations/mine');
  if (!list.length) {
    app.innerHTML = `<div class="card"><h2>我的报名</h2><div class="empty">你还没有报名任何活动</div>
      <a class="btn" data-link="#/events">去看看活动</a></div>`;
    return;
  }
  app.innerHTML = `<div class="card"><h2>我的报名</h2></div>` + list.map((r) => `
    <div class="card event-item">
      <div>
        <strong>${esc(r.eventTitle)}</strong>
        <div class="meta">报名时间：${new Date(r.createdAt).toLocaleString()}
          ${r.submitted ? ' ｜ <span style="color:var(--success)">问卷已提交</span>' : ' ｜ 问卷未提交'}</div>
      </div>
      <div class="row">
        <a class="btn secondary small" data-link="#/events/${r.eventId}">活动详情</a>
        ${r.status === 'published' && !r.submitted
          ? `<a class="btn small" data-link="#/events/${r.eventId}/survey">填写问卷</a>`
          : ''}
      </div>
    </div>`).join('');
}

// ---------- 页面：组织者 - 活动管理列表 ----------

async function pageOrganizer() {
  const user = requireRole('organizer');
  if (!user) return;
  app.innerHTML = `<div class="card muted">加载中…</div>`;
  const events = await api('GET', '/api/events/mine');
  app.innerHTML = `
    <div class="card row">
      <h2 style="margin:0">我创建的活动</h2>
      <div class="spacer"></div>
      <button id="btn-new">＋ 新建活动问卷</button>
    </div>
    <div id="event-list"></div>`;
  document.getElementById('btn-new').onclick = () => pageEventEditor(null);

  const listEl = document.getElementById('event-list');
  if (!events.length) {
    listEl.innerHTML = `<div class="card empty">还没有活动，点击右上角「新建活动问卷」开始。</div>`;
    return;
  }
  listEl.innerHTML = events.map((ev) => `
    <div class="card event-item">
      <div>
        <div class="row"><strong>${esc(ev.title)}</strong>
          <span class="badge ${ev.status}">${ev.status === 'draft' ? '草稿（问卷未开放）' : '已发布（问卷开放中）'}</span>
        </div>
        <div class="meta">${ev.questions.length} 道题 ｜ 报名 ${ev.registeredCount} 人 ｜ 提交 ${ev.submissionCount} 份</div>
      </div>
      <div class="row">
        ${ev.status === 'draft'
          ? `<a class="btn secondary small" data-link="#/organizer/events/${ev.id}">编辑问卷</a>`
          : `<a class="btn secondary small" data-link="#/organizer/events/${ev.id}">查看问卷</a>`}
        <a class="btn small" data-link="#/organizer/events/${ev.id}/results">结果看板</a>
      </div>
    </div>`).join('');
}

// ---------- 页面：组织者 - 问卷编辑器 ----------

let editorDraft = null; // 正在编辑的题目草稿

function qDraft(q) {
  return q
    ? { id: q.id, type: q.type, title: q.title, required: q.required, options: q.options ? q.options.map((o) => o.label) : [] }
    : { type: 'single', title: '', required: false, options: ['', ''] };
}

async function pageEventEditor(eventId) {
  const user = requireRole('organizer');
  if (!user) return;

  let ev = null;
  if (eventId) ev = await api('GET', `/api/events/${eventId}`);
  editorDraft = {
    title: ev ? ev.title : '',
    description: ev ? ev.description : '',
    questions: ev ? ev.questions.map(qDraft) : [qDraft()],
  };
  const locked = ev && ev.status !== 'draft';

  function render() {
    app.innerHTML = `
      <div class="card">
        <h2>${ev ? '编辑活动问卷' : '新建活动问卷'}</h2>
        ${locked ? `<p class="muted">活动已发布，问卷题目已锁定，不能再编辑。<a data-link="#/organizer/events/${ev.id}/results">前往结果看板</a></p>` : ''}
        <label class="field">活动标题<input type="text" id="ev-title" value="${esc(editorDraft.title)}" ${locked ? 'disabled' : ''} /></label>
        <label class="field">活动介绍<textarea id="ev-desc" ${locked ? 'disabled' : ''}>${esc(editorDraft.description)}</textarea></label>
      </div>
      <div id="q-list"></div>
      <div class="card row">
        ${!locked ? '<button class="secondary" id="btn-add-q">＋ 添加题目</button>' : ''}
        <div class="spacer"></div>
        ${!locked
          ? (ev
              ? `<button class="secondary" id="btn-save">保存草稿</button><button id="btn-publish">保存并发布</button>`
              : `<button id="btn-create">创建活动（草稿）</button>`)
          : `<a class="btn" data-link="#/organizer">返回列表</a>`}
      </div>
      <div class="error-text" id="err"></div>`;

    document.getElementById('q-list').innerHTML = editorDraft.questions.map((q, qi) => `
      <div class="card">
        <div class="row">
          <h3 style="margin:0">第 ${qi + 1} 题</h3>
          <div class="spacer"></div>
          ${!locked ? `<select data-q="${qi}" data-field="type" style="width:auto;margin:0">
            <option value="single" ${q.type === 'single' ? 'selected' : ''}>单选题</option>
            <option value="multi" ${q.type === 'multi' ? 'selected' : ''}>多选题</option>
            <option value="text" ${q.type === 'text' ? 'selected' : ''}>文本题</option>
          </select>
          <label class="row" style="font-size:13px;font-weight:400;margin:0">
            <input type="checkbox" data-q="${qi}" data-field="required" ${q.required ? 'checked' : ''} style="margin:0" /> 必填
          </label>
          <button class="danger small" data-q-remove="${qi}">删除题目</button>` : ''}
        </div>
        <input type="text" data-q="${qi}" data-field="title" value="${esc(q.title)}" placeholder="请输入题目标题" ${locked ? 'disabled' : ''} />
        <div class="q-options" data-q-options="${qi}"></div>
      </div>`).join('');

    // 绑定通用输入
    app.querySelectorAll('[data-q][data-field]').forEach((el) => {
      const qi = Number(el.getAttribute('data-q'));
      const field = el.getAttribute('data-field');
      const sync = () => {
        if (field === 'type') {
          const old = editorDraft.questions[qi];
          const next = qDraft();
          next.type = el.value;
          next.title = old.title;
          next.required = old.required;
          editorDraft.questions[qi] = next;
          render();
          return;
        }
        editorDraft.questions[qi][field] = field === 'required' ? el.checked : el.value;
      };
      el.addEventListener('change', sync);
      el.addEventListener('input', sync);
    });

    // 活动标题/介绍同步
    const titleEl = document.getElementById('ev-title');
    const descEl = document.getElementById('ev-desc');
    if (!locked) {
      titleEl.addEventListener('input', () => { editorDraft.title = titleEl.value; });
      descEl.addEventListener('input', () => { editorDraft.description = descEl.value; });
    }

    // 选项区
    editorDraft.questions.forEach((q, qi) => {
      const box = app.querySelector(`[data-q-options="${qi}"]`);
      if (q.type === 'text') {
        box.innerHTML = `<p class="muted" style="margin:8px 0 0">参与者将看到一个多行文本输入框。</p>`;
        return;
      }
      box.innerHTML = q.options.map((label, oi) => `
        <div class="opt-row row">
          <span>${oi + 1}.</span>
          <input type="text" data-opt-q="${qi}" data-opt-i="${oi}" value="${esc(label)}" placeholder="选项内容" ${locked ? 'disabled' : ''} />
          ${!locked && q.options.length > 2 ? `<button class="danger small" data-opt-remove="${qi}" data-opt-i="${oi}">删</button>` : ''}
        </div>`).join('') +
        (locked ? '' : `<button class="secondary small" data-opt-add="${qi}" style="margin-top:6px">＋ 添加选项</button>`);
    });

    if (locked) return;

    app.querySelectorAll('[data-opt-q]').forEach((el) => {
      el.addEventListener('input', () => {
        editorDraft.questions[Number(el.dataset.optQ)].options[Number(el.dataset.optI)] = el.value;
      });
    });
    app.querySelectorAll('[data-opt-add]').forEach((el) =>
      el.addEventListener('click', () => {
        editorDraft.questions[Number(el.getAttribute('data-opt-add'))].options.push('');
        render();
      }));
    app.querySelectorAll('[data-opt-remove]').forEach((el) =>
      el.addEventListener('click', () => {
        const qi = Number(el.getAttribute('data-opt-remove'));
        editorDraft.questions[qi].options.splice(Number(el.getAttribute('data-opt-i')), 1);
        render();
      }));
    app.querySelectorAll('[data-q-remove]').forEach((el) =>
      el.addEventListener('click', () => {
        editorDraft.questions.splice(Number(el.getAttribute('data-q-remove')), 1);
        render();
      }));

    document.getElementById('btn-add-q').onclick = () => { editorDraft.questions.push(qDraft()); render(); };

    const buildPayload = () => ({
      title: editorDraft.title,
      description: editorDraft.description,
      questions: editorDraft.questions.map((q) => ({
        type: q.type,
        title: q.title,
        required: q.required,
        options: q.type === 'text' ? undefined : q.options,
      })),
    });

    const showErr = (e) => { document.getElementById('err').textContent = e.message; };

    const createBtn = document.getElementById('btn-create');
    if (createBtn) createBtn.onclick = async () => {
      try {
        const created = await api('POST', '/api/events', buildPayload());
        toast('草稿已创建', 'success');
        go(`#/organizer/events/${created.id}`);
      } catch (e) { showErr(e); }
    };
    const saveBtn = document.getElementById('btn-save');
    if (saveBtn) saveBtn.onclick = async () => {
      try {
        await api('PUT', `/api/events/${ev.id}`, buildPayload());
        toast('草稿已保存', 'success');
        pageOrganizer();
      } catch (e) { showErr(e); }
    };
    const pubBtn = document.getElementById('btn-publish');
    if (pubBtn) pubBtn.onclick = async () => {
      try {
        await api('PUT', `/api/events/${ev.id}`, buildPayload());
        await api('POST', `/api/events/${ev.id}/publish`);
        toast('活动已发布，问卷正式开放', 'success');
        go(`#/organizer/events/${ev.id}/results`);
      } catch (e) { showErr(e); }
    };
  }

  render();
}

// ---------- 页面：组织者 - 结果看板 ----------

async function pageResults(eventId) {
  const user = requireRole('organizer');
  if (!user) return;
  app.innerHTML = `<div class="card muted">加载中…</div>`;
  const r = await api('GET', `/api/events/${eventId}/results`);

  const maxCount = (qr) => Math.max(1, ...qr.options.map((o) => o.count));

  app.innerHTML = `
    <div class="card">
      <div class="row">
        <h2 style="margin:0">${esc(r.event.title)} · 反馈结果</h2>
        <span class="badge ${r.event.status}">${r.event.status === 'draft' ? '草稿' : '已发布'}</span>
      </div>
      <div class="stat-row" style="margin-top:14px;">
        <div class="stat-box"><div class="num">${r.registeredCount}</div><div class="lbl">报名人数</div></div>
        <div class="stat-box"><div class="num">${r.submissionCount}</div><div class="lbl">问卷提交人数</div></div>
        <div class="stat-box"><div class="num">${r.registeredCount ? Math.round((r.submissionCount / r.registeredCount) * 100) : 0}%</div><div class="lbl">提交率</div></div>
      </div>
      <a class="btn secondary small" data-link="#/organizer">返回列表</a>
    </div>
    ${r.questions.map((q) => `
      <div class="card">
        <h3>${esc(q.title)}</h3>
        <div class="muted">${q.type === 'single' ? '单选题' : q.type === 'multi' ? '多选题' : '文本题'}
          ${q.required ? ' · 必填' : ''} · 作答 ${q.answeredCount} 人</div>
        ${q.type === 'text'
          ? (q.textAnswers.length
              ? q.textAnswers.map((a) => `
                <div class="answer-item">
                  <div class="who">${esc(a.nickname)} ｜ ${new Date(a.submittedAt).toLocaleString()}</div>
                  ${esc(a.value).replace(/\n/g, '<br />')}
                </div>`).join('')
              : `<div class="empty">暂时没有文本回答</div>`)
          : q.options.map((o) => {
              const pct = Math.round((o.count / maxCount(q)) * 100);
              return `<div class="dist-row">
                <span title="${esc(o.label)}">${esc(o.label)}</span>
                <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
                <span class="bar-count">${o.count} 人</span>
              </div>`;
            }).join('')}
      </div>`).join('')}`;
}

// ---------- hash 路由 ----------

async function router() {
  renderNav();
  const hash = window.location.hash || '#/events';
  const parts = hash.replace(/^#\//, '').split('/');
  try {
    if (parts[0] === 'login') return pageLogin();
    if (parts[0] === 'register') return pageRegister();
    if (parts[0] === 'events' && parts[1] && parts[2] === 'survey') return pageSurvey(parts[1]);
    if (parts[0] === 'events' && parts[1]) return pageEventDetail(parts[1]);
    if (parts[0] === 'events' || parts[0] === '') return pageEvents();
    if (parts[0] === 'my') return pageMy();
    if (parts[0] === 'organizer' && parts[1] === 'events' && parts[3] === 'results') return pageResults(parts[2]);
    if (parts[0] === 'organizer' && parts[1] === 'events' && parts[2]) return pageEventEditor(parts[2]);
    if (parts[0] === 'organizer') return pageOrganizer();
    go('#/events');
  } catch (e) {
    if (e.status === 401) {
      state.token = null;
      state.user = null;
      go('#/login');
      toast('登录已过期，请重新登录', 'error');
    } else {
      app.innerHTML = `<div class="card"><h2>出错了</h2><p class="error-text">${esc(e.message)}</p>
        <a class="btn secondary" data-link="#/events">返回活动列表</a></div>`;
    }
  }
}

window.addEventListener('hashchange', router);
router();
