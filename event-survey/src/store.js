'use strict';

// JSON 文件持久化：每个集合一个 .json 文件。
// 单进程演示服务，采用「启动加载到内存 + 写时原子落盘」策略：
// 先写临时文件再 rename，避免进程崩溃导致数据文件写一半损坏。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const COLLECTIONS = ['users', 'events', 'registrations', 'submissions', 'tokens'];

class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.data = {};
    fs.mkdirSync(dataDir, { recursive: true });
    for (const name of COLLECTIONS) {
      this.data[name] = this.#load(name);
    }
  }

  #file(name) {
    return path.join(this.dataDir, `${name}.json`);
  }

  #load(name) {
    const file = this.#file(name);
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    return JSON.parse(raw);
  }

  all(name) {
    return this.data[name];
  }

  find(name, predicate) {
    return this.data[name].find(predicate) || null;
  }

  filter(name, predicate) {
    return this.data[name].filter(predicate);
  }

  insert(name, record) {
    this.data[name].push(record);
    this.persist(name);
    return record;
  }

  update(name, predicate, patch) {
    const record = this.find(name, predicate);
    if (!record) return null;
    Object.assign(record, patch);
    this.persist(name);
    return record;
  }

  // 整块替换（用于已经在内存中修改过对象的场景），随后落盘。
  persist(name) {
    const file = this.#file(name);
    const tmp = path.join(this.dataDir, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(this.data[name], null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
}

const store = new JsonStore(config.dataDir);

module.exports = { store, COLLECTIONS };
