'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const dbmod = require('./db');
const sec = require('./security');
const { Hub } = require('./realtime');
const { TEMPLATES } = require('./templates');
const aiMod = require('./ai');
const { Chat, ChatError } = require('./chat');
const Doc = require('../public/doc.js');

const ROLES = ['admin', 'editor', 'viewer'];
const USER_COLORS = ['#187bcd', '#e0592a', '#2f9e6e', '#8a5cd6', '#d1a100', '#d6336c', '#0b9aa8', '#5c7080'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function createApp(config, deps = {}) {
  const db = dbmod.open(config.dataDir);
  const settings = require('./settings').open(db, config.dataDir);
  const MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best results, default)' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (about half the price)' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest and cheapest)' },
    { id: 'claude-fable-5-2', label: 'Claude Fable 5.2 (most capable, highest price)' },
  ];
  let clientCache = { key: null, client: null };
  // Current Claude settings. Read on every request so changes on the Settings page apply immediately.
  // A key saved in Settings wins over the ANTHROPIC_API_KEY environment variable.
  function aiRuntime() {
    const saved = settings.getSecret('anthropic_api_key');
    const key = saved || config.anthropicApiKey || '';
    const on = settings.get('ai_enabled') !== '0';
    let client = deps.anthropic || null;
    if (!client && key) {
      if (clientCache.key !== key) {
        const Anthropic = require('@anthropic-ai/sdk');
        clientCache = { key, client: new Anthropic({ apiKey: key, maxRetries: 2, timeout: 180000 }) };
      }
      client = clientCache.client;
    }
    const fb = settings.get('ai_fallback');
    return {
      client: on ? client : null,
      hasKey: !!client,
      on,
      source: saved ? 'settings' : config.anthropicApiKey ? 'env' : deps.anthropic ? 'injected' : 'none',
      keyHint: key ? key.slice(0, 7) + '…' + key.slice(-4) : '',
      model: settings.get('ai_model') || config.aiModel,
      effort: settings.get('ai_effort') || config.aiEffort,
      perHour: Number(settings.get('ai_per_hour')) || config.aiPerHour,
      fallback: fb === null ? config.aiFallback : fb === '1',
      autoApply: settings.get('ai_auto_apply') !== '0',
    };
  }
  const ai = aiMod.create({ runtime: aiRuntime });
  const COOKIE = config.cookieSecure ? '__Host-idm' : 'idm';

  const q = {
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT id, email, name, role, color, disabled, created_at FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, password_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    allUsers: db.prepare('SELECT id, email, name, role, color, disabled, created_at FROM users ORDER BY created_at'),
    activeAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?"),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    updateUser: db.prepare('UPDATE users SET role = ?, disabled = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    sessionByHash: db.prepare(`SELECT s.token_hash, s.csrf, s.expires_at, u.id AS uid, u.email, u.name, u.role, u.color, u.disabled
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    insertInvite: db.prepare('INSERT INTO invites (token_hash, role, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'),
    inviteByHash: db.prepare('SELECT * FROM invites WHERE token_hash = ?'),
    useInvite: db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL'),
    listInvites: db.prepare(`SELECT i.id, i.role, i.note, i.created_at, i.expires_at, i.used_at, u.name AS created_by_name, v.name AS used_by_name
      FROM invites i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN users v ON v.id = i.used_by ORDER BY i.created_at DESC LIMIT 100`),
    deleteInvite: db.prepare('DELETE FROM invites WHERE id = ?'),
    listMaps: db.prepare(`SELECT m.id, m.title, m.node_count, m.updated_at, m.created_at, m.owner_id, u.name AS owner_name
      FROM maps m LEFT JOIN users u ON u.id = m.owner_id
      WHERE (@q = '' OR m.search_text LIKE @like ESCAPE '\\') ORDER BY m.updated_at DESC LIMIT 200`),
    mapRow: db.prepare('SELECT m.*, u.name AS owner_name FROM maps m LEFT JOIN users u ON u.id = m.owner_id WHERE m.id = ?'),
    insertMap: db.prepare('INSERT INTO maps (id, title, data, search_text, node_count, version, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)'),
    renameMap: db.prepare('UPDATE maps SET title = ?, search_text = ?, updated_at = ? WHERE id = ?'),
    deleteMap: db.prepare('DELETE FROM maps WHERE id = ?'),
  };

  const loginByIp = new sec.Throttle({ limit: 30, windowMs: 15 * 60 * 1000 });
  const loginByKey = new sec.Throttle({ limit: 6, windowMs: 15 * 60 * 1000 });

  /* ---------- request helpers ---------- */

  function clientIp(req) {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1]; // one trusted hop: the address our proxy saw
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function requestHost(req) {
    if (config.trustProxy && req.headers['x-forwarded-host']) return String(req.headers['x-forwarded-host']).split(',')[0].trim();
    return req.headers.host || '';
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return false;
    const clean = origin.replace(/\/+$/, '');
    if (config.allowedOrigins.has(clean)) return true;
    try {
      return new URL(origin).host === requestHost(req);
    } catch {
      return false;
    }
  }

  function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }

  function sessionFromCookie(header) {
    const token = parseCookies(header)[COOKIE];
    if (!token || token.length > 200) return null;
    const row = q.sessionByHash.get(sec.sha256(token));
    if (!row) return null;
    if (row.expires_at < Date.now() || row.disabled) {
      q.deleteSession.run(row.token_hash);
      return null;
    }
    return {
      hash: row.token_hash,
      csrf: row.csrf,
      user: { id: row.uid, email: row.email, name: row.name, role: row.role, color: row.color },
    };
  }

  function setSessionCookie(res, token) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`];
    if (config.cookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function clearSessionCookie(res) {
    const parts = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (config.cookieSecure) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function createSession(res, userId) {
    const token = sec.randomToken(32);
    const csrf = sec.randomToken(24);
    const now = Date.now();
    q.insertSession.run(sec.sha256(token), userId, csrf, now, now + config.sessionTtlMs);
    setSessionCookie(res, token);
    return csrf;
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers['content-type'] || '').toLowerCase();
      if (!type.startsWith('application/json')) return reject(new HttpError(415, 'Send JSON'));
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new HttpError(413, 'Request too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
          resolve(v);
        } catch {
          reject(new HttpError(400, 'Invalid JSON'));
        }
      });
      req.on('error', () => reject(new HttpError(400, 'Bad request')));
    });
  }

  function send(res, status, body, headers) {
    const data = JSON.stringify(body);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) }, headers));
    res.end(data);
  }

  function baseHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  /* ---------- validation ---------- */

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  function checkCredentialsInput(b, { needName }) {
    const name = str(b.name, 80);
    const email = str(b.email, 254).toLowerCase();
    const password = typeof b.password === 'string' ? b.password : '';
    if (needName && !name) throw new HttpError(400, 'Please enter your name');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address');
    if (password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
    if (password.length > 200) throw new HttpError(400, 'Password is too long');
    return { name, email, password };
  }

  function pickColor() {
    const n = q.userCount.get().n;
    return USER_COLORS[n % USER_COLORS.length];
  }

  const canEdit = (user) => user.role === 'admin' || user.role === 'editor';

  function validTitle(v) {
    const t = str(v, 120);
    if (!t) throw new HttpError(400, 'Please give the map a title');
    return t.replace(/[\u0000-\u001f\u007f]/g, '');
  }

  /* ---------- routes ---------- */

  const routes = [];
  const route = (method, pattern, auth, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]{1,64})'; }) + '$');
    routes.push({ method, re, keys, auth, handler });
  };

  // --- session & setup ---
  route('GET', '/api/session', null, ({ sess }) => ({
    needsSetup: q.userCount.get().n === 0,
    setupTokenRequired: !!config.setupToken,
    ai: (() => { const r = aiRuntime(); return { enabled: !!r.client, autoApply: r.autoApply }; })(),
    user: sess ? sess.user : null,
    csrf: sess ? sess.csrf : null,
  }));

  route('POST', '/api/setup', null, ({ body, res, ip }) => {
    const wait = loginByIp.blocked(ip);
    if (wait) throw new HttpError(429, 'Too many attempts. Try again later.', { retryAfter: wait });
    if (config.setupToken && !sec.safeEqual(str(body.setupToken, 200), config.setupToken)) {
      loginByIp.fail(ip);
      throw new HttpError(403, 'Wrong setup token');
    }
    const c = checkCredentialsInput(body, { needName: true });
    const hash = sec.hashPassword(c.password);
    const tx = db.transaction(() => {
      if (q.userCount.get().n > 0) throw new HttpError(409, 'Setup is already complete');
      return q.insertUser.run(c.email, c.name, hash, 'admin', USER_COLORS[0], Date.now()).lastInsertRowid;
    });
    const id = Number(tx());
    const csrf = createSession(res, id);
    return { user: q.userById.get(id), csrf };
  });

  route('POST', '/api/login', null, ({ body, res, ip }) => {
    const email = str(body.email, 254).toLowerCase();
    const password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const keyId = ip + '|' + email;
    const wait = Math.max(loginByIp.blocked(ip), loginByKey.blocked(keyId));
    if (wait) throw new HttpError(429, 'Too many failed attempts. Try again in ' + Math.ceil(wait / 60) + ' minute(s).', { retryAfter: wait });
    const user = q.userByEmail.get(email);
    const ok = sec.verifyPassword(password, user ? user.password_hash : sec.DUMMY_HASH) && user && !user.disabled;
    if (!ok) {
      loginByIp.fail(ip);
      loginByKey.fail(keyId);
      throw new HttpError(401, 'Wrong email or password');
    }
    loginByKey.clear(keyId);
    const csrf = createSession(res, user.id);
    return { user: q.userById.get(user.id), csrf };
  });

  route('POST', '/api/logout', 'user', ({ sess, res }) => {
    q.deleteSession.run(sess.hash);
    clearSessionCookie(res);
    return { ok: true };
  });

  route('POST', '/api/me/password', 'user', ({ sess, body }) => {
    const row = q.userByEmail.get(sess.user.email);
    if (!sec.verifyPassword(typeof body.current === 'string' ? body.current : '', row.password_hash)) throw new HttpError(403, 'Current password is wrong');
    const next = typeof body.next === 'string' ? body.next : '';
    if (next.length < 10 || next.length > 200) throw new HttpError(400, 'New password must be 10 to 200 characters');
    q.setPassword.run(sec.hashPassword(next), sess.user.id);
    q.deleteOtherSessions.run(sess.user.id, sess.hash);
    hub.kickUser(sess.user.id, 'Password changed');
    chat.kickUser(sess.user.id, 'Password changed');
    return { ok: true };
  });

  // --- invites ---
  function findInvite(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const inv = q.inviteByHash.get(sec.sha256(token));
    if (!inv || inv.used_at || inv.expires_at < Date.now()) return null;
    return inv;
  }

  route('GET', '/api/invites/:token', null, ({ params, ip }) => {
    const wait = loginByIp.blocked(ip);
    if (wait) throw new HttpError(429, 'Too many attempts. Try again later.', { retryAfter: wait });
    const inv = findInvite(params.token);
    if (!inv) {
      loginByIp.fail(ip);
      throw new HttpError(404, 'This invite link is invalid, expired or already used');
    }
    return { role: inv.role, note: inv.note, expiresAt: inv.expires_at };
  });

  route('POST', '/api/invites/:token/accept', null, ({ params, body, res, ip }) => {
    const wait = loginByIp.blocked(ip);
    if (wait) throw new HttpError(429, 'Too many attempts. Try again later.', { retryAfter: wait });
    const inv = findInvite(params.token);
    if (!inv) {
      loginByIp.fail(ip);
      throw new HttpError(404, 'This invite link is invalid, expired or already used');
    }
    const c = checkCredentialsInput(body, { needName: true });
    if (q.userByEmail.get(c.email)) throw new HttpError(409, 'That email already has an account. Ask an admin for help.');
    const hash = sec.hashPassword(c.password);
    const tx = db.transaction(() => {
      const id = Number(q.insertUser.run(c.email, c.name, hash, inv.role, pickColor(), Date.now()).lastInsertRowid);
      if (q.useInvite.run(Date.now(), id, inv.id).changes !== 1) throw new HttpError(404, 'This invite link is invalid, expired or already used');
      return id;
    });
    const id = tx();
    chat.markRead(id, 'team', Number.MAX_SAFE_INTEGER); // a new person starts caught up, not 500 messages behind
    const csrf = createSession(res, id);
    return { user: q.userById.get(id), csrf };
  });

  // --- admin ---
  route('GET', '/api/admin/users', 'admin', () => ({ users: q.allUsers.all() }));

  route('PATCH', '/api/admin/users/:id', 'admin', ({ params, body, sess }) => {
    const id = Number(params.id);
    const target = q.userById.get(id);
    if (!target) throw new HttpError(404, 'User not found');
    const role = body.role === undefined ? target.role : body.role;
    const disabled = body.disabled === undefined ? target.disabled : body.disabled ? 1 : 0;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Bad role');
    if ((role !== 'admin' || disabled) && target.role === 'admin' && !target.disabled && q.activeAdmins.get(id).n === 0) {
      throw new HttpError(400, 'There must be at least one active admin');
    }
    if (id === sess.user.id && disabled) throw new HttpError(400, 'You cannot disable yourself');
    q.updateUser.run(role, disabled, id);
    if (disabled) {
      q.deleteUserSessions.run(id);
      hub.kickUser(id, 'Account disabled');
      chat.kickUser(id, 'Account disabled');
    }
    return { user: q.userById.get(id) };
  });

  route('DELETE', '/api/admin/users/:id', 'admin', ({ params, sess }) => {
    const id = Number(params.id);
    const target = q.userById.get(id);
    if (!target) throw new HttpError(404, 'User not found');
    if (id === sess.user.id) throw new HttpError(400, 'You cannot delete yourself');
    if (target.role === 'admin' && !target.disabled && q.activeAdmins.get(id).n === 0) throw new HttpError(400, 'There must be at least one active admin');
    hub.kickUser(id, 'Account removed');
    chat.kickUser(id, 'Account removed');
    q.deleteUser.run(id);
    return { ok: true };
  });

  route('GET', '/api/admin/invites', 'admin', () => ({ invites: q.listInvites.all() }));

  route('POST', '/api/admin/invites', 'admin', ({ body, sess }) => {
    const role = body.role;
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role');
    const token = sec.randomToken(32);
    const now = Date.now();
    q.insertInvite.run(sec.sha256(token), role, str(body.note, 80), sess.user.id, now, now + config.inviteTtlMs);
    return { token, role, expiresAt: now + config.inviteTtlMs };
  });

  route('DELETE', '/api/admin/invites/:id', 'admin', ({ params }) => {
    q.deleteInvite.run(Number(params.id));
    return { ok: true };
  });

  // --- maps ---
  route('GET', '/api/templates', 'user', () => ({ templates: TEMPLATES.map(({ id, name, description }) => ({ id, name, description })) }));

  route('GET', '/api/maps', 'user', ({ query }) => {
    const text = str(query.get('q') || '', 100).toLowerCase();
    const like = '%' + text.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const maps = q.listMaps.all({ q: text, like }).map((m) => ({
      id: m.id, title: m.title, nodeCount: m.node_count, updatedAt: m.updated_at, createdAt: m.created_at, ownerId: m.owner_id, ownerName: m.owner_name,
    }));
    return { maps };
  });

  function saveNewMap(doc, title, ownerId) {
    const id = sec.randomToken(9);
    const now = Date.now();
    q.insertMap.run(id, title, JSON.stringify(doc), Doc.searchText(doc, title), Doc.count(doc), ownerId, now, now);
    return id;
  }

  const mapSummary = (id) => {
    const m = q.mapRow.get(id);
    return { id: m.id, title: m.title, nodeCount: m.node_count, updatedAt: m.updated_at, createdAt: m.created_at, ownerId: m.owner_id, ownerName: m.owner_name };
  };

  route('POST', '/api/maps', 'editor', ({ body, sess }) => {
    const tpl = TEMPLATES.find((t) => t.id === (body.template || 'blank'));
    if (!tpl) throw new HttpError(400, 'Unknown template');
    const title = body.title ? validTitle(body.title) : tpl.name === 'Blank map' ? 'Untitled map' : tpl.name;
    const doc = Doc.fromTree({ format: 'idea-map', root: tpl.root });
    return { map: mapSummary(saveNewMap(doc, title, sess.user.id)) };
  });

  route('POST', '/api/maps/import', 'editor', ({ body, sess }) => {
    let doc;
    try {
      doc = Doc.fromTree(body.data);
    } catch (e) {
      throw new HttpError(400, e.message || 'Could not read that file');
    }
    const title = validTitle(body.title || (body.data && body.data.title) || 'Imported map');
    return { map: mapSummary(saveNewMap(doc, title, sess.user.id)) };
  });

  function loadMap(id) {
    hub.flushRoom(id);
    const m = q.mapRow.get(id);
    if (!m) throw new HttpError(404, 'Map not found');
    return m;
  }

  route('GET', '/api/maps/:id', 'user', ({ params }) => {
    const m = loadMap(params.id);
    return { map: { id: m.id, title: m.title, ownerName: m.owner_name }, doc: JSON.parse(m.data) };
  });

  route('GET', '/api/maps/:id/export', 'user', ({ params, res }) => {
    const m = loadMap(params.id);
    const tree = Doc.toTree(JSON.parse(m.data), m.title);
    const slug = m.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'map';
    res.setHeader('Content-Disposition', `attachment; filename="${slug}.ideamap.json"`);
    return tree;
  });

  route('PATCH', '/api/maps/:id', 'editor', ({ params, body }) => {
    const m = loadMap(params.id);
    const title = validTitle(body.title);
    const doc = JSON.parse(m.data);
    q.renameMap.run(title, Doc.searchText(doc, title), Date.now(), m.id);
    hub.renameRoom(m.id, title);
    return { map: mapSummary(m.id) };
  });

  route('POST', '/api/maps/:id/duplicate', 'editor', ({ params, sess }) => {
    const m = loadMap(params.id);
    const title = ('Copy of ' + m.title).slice(0, 120);
    return { map: mapSummary(saveNewMap(JSON.parse(m.data), title, sess.user.id)) };
  });

  const aiError = (e) => (e instanceof aiMod.AiError ? new HttpError(e.status, e.message) : e);

  route('POST', '/api/maps/:id/ai', 'editor', async ({ params, body, sess }) => {
    const m = loadMap(params.id);
    try {
      return await ai.ask({ userId: sess.user.id, doc: JSON.parse(m.data), title: m.title, selected: body.selected, message: body.message, history: body.history });
    } catch (e) {
      throw aiError(e);
    }
  });

  const aiStatus = () => {
    const r = aiRuntime();
    return { enabled: !!r.client, hasKey: r.hasKey, on: r.on, source: r.source, keyHint: r.keyHint, model: r.model, effort: r.effort, perHour: r.perHour, fallback: r.fallback, autoApply: r.autoApply, models: MODELS };
  };

  route('GET', '/api/admin/ai', 'admin', () => aiStatus());

  route('PUT', '/api/admin/ai', 'admin', ({ body, sess }) => {
    const bool = (v, name) => {
      if (typeof v !== 'boolean') throw new HttpError(400, 'Bad value for ' + name);
      return v ? '1' : '0';
    };
    if (body.removeKey === true) settings.delete('anthropic_api_key');
    if (body.apiKey !== undefined) {
      const k = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(k)) throw new HttpError(400, 'That does not look like an Anthropic API key. It starts with sk-ant-');
      settings.setSecret('anthropic_api_key', k);
    }
    if (body.on !== undefined) settings.set('ai_enabled', bool(body.on, 'on'));
    if (body.fallback !== undefined) settings.set('ai_fallback', bool(body.fallback, 'fallback'));
    if (body.autoApply !== undefined) settings.set('ai_auto_apply', bool(body.autoApply, 'autoApply'));
    if (body.model !== undefined) {
      if (!MODELS.some((m) => m.id === body.model)) throw new HttpError(400, 'Choose one of the listed models');
      settings.set('ai_model', body.model);
    }
    if (body.effort !== undefined) {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(body.effort)) throw new HttpError(400, 'Bad effort level');
      settings.set('ai_effort', body.effort);
    }
    if (body.perHour !== undefined) {
      const n = Number(body.perHour);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new HttpError(400, 'Requests per hour must be between 1 and 1000');
      settings.set('ai_per_hour', String(n));
    }
    console.log(`Claude settings updated by user ${sess.user.id}`); // never logs the key
    return aiStatus();
  });

  route('POST', '/api/admin/ai/test', 'admin', async () => {
    try {
      return await ai.test();
    } catch (e) {
      throw aiError(e);
    }
  });

  route('DELETE', '/api/maps/:id', 'editor', ({ params, sess }) => {
    const m = loadMap(params.id);
    if (sess.user.role !== 'admin' && m.owner_id !== sess.user.id) throw new HttpError(403, 'Only the map owner or an admin can delete this map');
    hub.closeRoom(m.id);
    chat.dropRoom('map-' + m.id);
    q.deleteMap.run(m.id);
    return { ok: true };
  });

  // --- chat ---
  const chatError = (e) => (e instanceof ChatError ? new HttpError(e.status, e.message) : e);
  const chatCall = (fn) => {
    try { return fn(); } catch (e) { throw chatError(e); }
  };

  route('GET', '/api/chat/members', 'user', () => ({ members: chat.members() }));

  route('GET', '/api/chat/unread', 'user', ({ sess }) => ({ unread: chat.unread(sess.user.id) }));

  route('GET', '/api/chat/rooms/:room/messages', 'user', ({ params, query }) => chatCall(() => {
    const num = (k) => { const n = Number(query.get(k)); return Number.isInteger(n) && n > 0 ? n : undefined; };
    return chat.list(params.room, { before: num('before'), after: num('after'), limit: num('limit') });
  }));

  route('POST', '/api/chat/rooms/:room/messages', 'user', ({ params, body, sess }) => chatCall(() => ({ message: chat.post(sess.user, params.room, body.text) })));

  route('POST', '/api/chat/rooms/:room/read', 'user', ({ params, body, sess }) => chatCall(() => {
    chat.markRead(sess.user.id, params.room, body.lastId);
    return { ok: true };
  }));

  route('DELETE', '/api/chat/messages/:id', 'user', ({ params, sess }) => chatCall(() => {
    chat.remove(sess.user, Number(params.id));
    return { ok: true };
  }));

  /* ---------- dispatcher ---------- */

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (rel === '/') rel = '/index.html';
    const file = path.join(config.publicDir, rel);
    const ext = path.extname(file).toLowerCase();
    if (!file.startsWith(config.publicDir + path.sep) || !MIME[ext] || path.basename(file).startsWith('.')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': MIME[ext],
        ETag: etag,
        'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      headers['Content-Length'] = st.size;
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handle(req, res) {
    baseHeaders(res);
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    res.setHeader('Cache-Control', 'no-store');
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) {
        if (routes.some((x) => x.re.test(url.pathname))) throw new HttpError(405, 'Method not allowed');
        throw new HttpError(404, 'Not found');
      }
      const m = url.pathname.match(r.re);
      const params = {};
      r.keys.forEach((k, i) => { params[k] = m[i + 1]; });

      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      const sess = sessionFromCookie(req.headers.cookie);

      if (mutating) {
        if (req.headers['x-idea-map'] !== '1') throw new HttpError(403, 'Missing request header');
        if (req.headers.origin && !originAllowed(req)) throw new HttpError(403, 'Bad origin');
      }
      if (r.auth) {
        if (!sess) throw new HttpError(401, 'Please sign in');
        if (mutating && !sec.safeEqual(req.headers['x-csrf-token'] || '', sess.csrf)) throw new HttpError(403, 'Bad CSRF token');
        if (r.auth === 'admin' && sess.user.role !== 'admin') throw new HttpError(403, 'Admins only');
        if (r.auth === 'editor' && !canEdit(sess.user)) throw new HttpError(403, 'You have view-only access');
      }
      let body = {};
      if (mutating && req.method !== 'DELETE') body = await readBody(req, url.pathname === '/api/maps/import' ? 3 * 1024 * 1024 : 64 * 1024);
      const out = await r.handler({ req, res, params, query: url.searchParams, body, sess, ip: clientIp(req) });
      send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) {
        const headers = e.extra && e.extra.retryAfter ? { 'Retry-After': String(e.extra.retryAfter) } : undefined;
        return send(res, e.status, { error: e.message }, headers);
      }
      console.error('Unhandled error', e);
      send(res, 500, { error: 'Something went wrong' });
    }
  }

  /* ---------- assemble ---------- */

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong' });
    });
  });

  const hub = new Hub({
    db,
    config,
    auth: {
      sessionFromCookie,
      checkOrigin: originAllowed,
    },
  });
  const chat = new Chat({ db, sessionFromCookie, originAllowed });
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* handled below */ }
    if (pathname === '/ws/chat') chat.handleUpgrade(req, socket, head);
    else hub.handleUpgrade(req, socket, head);
  });

  const pruneTimer = setInterval(() => q.pruneSessions.run(Date.now()), 3600 * 1000);
  pruneTimer.unref();

  function close() {
    clearInterval(pruneTimer);
    hub.close();
    chat.close();
    return new Promise((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
      server.closeAllConnections && server.closeAllConnections();
    });
  }

  return { server, hub, db, close };
}

module.exports = { createApp };
