const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { LOG_FILE } = require('./config');

function nowISO() { return new Date().toISOString(); }
function genTraceId() { return crypto.randomBytes(6).toString('hex'); }

const ring = [];
const RING_MAX = 500;

function log(level, msg, extra = {}) {
  const entry = { t: nowISO(), level, msg, ...extra };
  const line = JSON.stringify(entry);
  console.log(line);
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  if (LOG_FILE) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch { /* ignore */ }
  }
}

function tail(n = 50) {
  n = Math.max(1, Math.min(200, n));
  return ring.slice(-n);
}

module.exports = { log, tail, genTraceId };
