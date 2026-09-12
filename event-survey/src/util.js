'use strict';

const crypto = require('crypto');

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function now() {
  return new Date().toISOString();
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = { id, now, trim };
