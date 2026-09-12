'use strict';

const { store } = require('../store');
const { hashPassword, checkPassword, issueToken } = require('../auth');
const { HttpError } = require('../http-util');
const { id, now, trim } = require('../util');

const publicUser = (u) => ({ id: u.id, username: u.username, nickname: u.nickname, role: u.role });

function register({ username, password, nickname, role }) {
  username = trim(username);
  nickname = trim(nickname) || username;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new HttpError(400, 'INVALID_USERNAME', '用户名需为 3-20 位字母、数字或下划线');
  }
  if (typeof password !== 'string' || password.length < 6) {
    throw new HttpError(400, 'INVALID_PASSWORD', '密码至少 6 位');
  }
  if (role !== 'organizer' && role !== 'participant') {
    throw new HttpError(400, 'INVALID_ROLE', '角色只能是 organizer 或 participant');
  }
  if (store.find('users', (u) => u.username === username)) {
    throw new HttpError(409, 'USERNAME_TAKEN', '用户名已存在');
  }
  const user = {
    id: id('usr'),
    username,
    nickname,
    role,
    passwordHash: hashPassword(password),
    createdAt: now(),
  };
  store.insert('users', user);
  return login({ username, password });
}

function login({ username, password }) {
  username = trim(username);
  const user = store.find('users', (u) => u.username === username);
  if (!user || !checkPassword(String(password || ''), user.passwordHash)) {
    throw new HttpError(401, 'BAD_CREDENTIALS', '用户名或密码错误');
  }
  const token = issueToken(user.id);
  store.insert('tokens', { token, userId: user.id, createdAt: now() });
  return { token, user: publicUser(user) };
}

function logout(token) {
  const record = store.find('tokens', (t) => t.token === token);
  if (record) {
    const list = store.all('tokens').filter((t) => t.token !== token);
    store.data.tokens.splice(0, store.data.tokens.length, ...list);
    store.persist('tokens');
  }
}

module.exports = { register, login, logout, publicUser };
