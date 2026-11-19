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
    // Claude assistant (off unless ANTHROPIC_API_KEY is set)
    anthropicApiKey: (env.ANTHROPIC_API_KEY || '').trim(),
    aiModel: (env.CLAUDE_MODEL || 'claude-opus-5-5').trim(),
    aiEffort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(env.CLAUDE_EFFORT) ? env.CLAUDE_EFFORT : 'medium',
    aiPerHour: Math.max(1, Number(env.AI_REQUESTS_PER_HOUR) || 60),
    aiFallback: env.CLAUDE_FALLBACK === undefined ? true : truthy(env.CLAUDE_FALLBACK),
    allowedOrigins: allowed,
    inviteTtlMs: 7 * 24 * 3600 * 1000,
    sessionTtlMs: 14 * 24 * 3600 * 1000,
    publicDir: path.join(__dirname, '..', 'public'),
  };
}

module.exports = { load };
