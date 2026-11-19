'use strict';
const path = require('path');

const truthy = (v) => v === '1' || String(v).toLowerCase() === 'true';

function load(env = process.env) {
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/+$/, '');
  const allowed = new Set(
    String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean)
  );
  if (publicUrl) allowed.add(publicUrl);
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    trustProxy: truthy(env.TRUST_PROXY),
    cookieSecure: truthy(env.COOKIE_SECURE),
    publicUrl,
    setupToken: env.SETUP_TOKEN || '',
    allowedOrigins: allowed,
    inviteTtlMs: 7 * 24 * 3600 * 1000,
    sessionTtlMs: 14 * 24 * 3600 * 1000,
    publicDir: path.join(__dirname, '..', 'public'),
  };
}

module.exports = { load };
