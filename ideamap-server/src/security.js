'use strict';
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Used so a login for an unknown email costs the same as one for a real email.
const DUMMY_HASH = hashPassword('not-a-real-password-' + crypto.randomBytes(8).toString('hex'));

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// In-memory login throttle: N failures in a window locks that key for the window.
class Throttle {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  _prune(now) {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
  }
  blocked(key, now = Date.now()) {
    const v = this.hits.get(key);
    if (!v || v.reset <= now) return 0;
    return v.count >= this.limit ? Math.ceil((v.reset - now) / 1000) : 0;
  }
  fail(key, now = Date.now()) {
    this._prune(now);
    const v = this.hits.get(key);
    if (!v || v.reset <= now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else v.count++;
  }
  clear(key) {
    this.hits.delete(key);
  }
}

module.exports = { hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256, safeEqual, Throttle };
