'use strict';
const { WebSocketServer } = require('ws');

/*
 * Team chat. Two kinds of room: "team" (everyone) and "map-<mapId>" (the discussion for one map).
 * Messages are saved in SQLite and sent over REST (so they are CSRF-protected and rate-limited like
 * everything else). A separate WebSocket at /ws/chat only pushes: new messages, deletions, who is
 * online in a room, and who is typing. Everyone who is signed in can read and write, viewers included.
 */

const MAX_TEXT = 2000;
const PAGE = 50;
const RATE_COUNT = 12; // messages
const RATE_WINDOW_MS = 20000; // per 20 seconds, per person
const MAX_ROOMS_PER_SOCKET = 4;

class ChatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cleanMessage(raw) {
  if (typeof raw !== 'string') throw new ChatError(400, 'Type a message first');
  const text = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!text) throw new ChatError(400, 'Type a message first');
  if (text.length > MAX_TEXT) throw new ChatError(400, `That message is too long (${MAX_TEXT} characters at most)`);
  return text;
}

class Chat {
  constructor({ db, sessionFromCookie, originAllowed }) {
    this.db = db;
    this.sessionFromCookie = sessionFromCookie;
    this.originAllowed = originAllowed;
    this.conns = new Set();
    this.sent = new Map(); // userId -> recent send timestamps
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
    this.q = {
      mapExists: db.prepare('SELECT 1 FROM maps WHERE id = ?'),
      insert: db.prepare('INSERT INTO chat_messages (room, user_id, text, created_at) VALUES (?, ?, ?, ?)'),
      byId: db.prepare('SELECT m.id, m.room, m.user_id, m.text, m.created_at, m.deleted, u.name, u.color FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?'),
      before: db.prepare('SELECT m.id, m.room, m.user_id, m.text, m.created_at, u.name, u.color FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.room = ? AND m.deleted = 0 AND m.id < ? ORDER BY m.id DESC LIMIT ?'),
      after: db.prepare('SELECT m.id, m.room, m.user_id, m.text, m.created_at, u.name, u.color FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.room = ? AND m.deleted = 0 AND m.id > ? ORDER BY m.id ASC LIMIT 200'),
      softDelete: db.prepare('UPDATE chat_messages SET deleted = 1 WHERE id = ?'),
      maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM chat_messages WHERE room = ?'),
      setRead: db.prepare('INSERT INTO chat_reads (user_id, room, last_id) VALUES (?, ?, ?) ON CONFLICT(user_id, room) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)'),
      unread: db.prepare(`SELECT m.room AS room, COUNT(*) AS n FROM chat_messages m
        WHERE m.deleted = 0 AND (m.user_id IS NULL OR m.user_id != @me)
          AND m.id > COALESCE((SELECT last_id FROM chat_reads r WHERE r.user_id = @me AND r.room = m.room), 0)
        GROUP BY m.room`),
      members: db.prepare('SELECT id, name, color FROM users WHERE disabled = 0 ORDER BY name COLLATE NOCASE'),
      userActive: db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled = 0'),
      dropRoom: db.prepare('DELETE FROM chat_messages WHERE room = ?'),
      dropReads: db.prepare('DELETE FROM chat_reads WHERE room = ?'),
    };
    this.heartbeat = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* gone */ }
      }
    }, 30000);
    this.heartbeat.unref();
  }

  /* ---------- rooms ---------- */

  roomAllowed(room) {
    if (room === 'team') return true;
    return typeof room === 'string' && /^map-[A-Za-z0-9_-]{1,40}$/.test(room) && !!this.q.mapExists.get(room.slice(4));
  }

  requireRoom(room) {
    if (!this.roomAllowed(room)) throw new ChatError(404, 'That chat room does not exist');
  }

  /* ---------- data ---------- */

  shape(r) {
    return { id: r.id, room: r.room, userId: r.user_id, name: r.name || 'Former member', color: r.color || '#5c7080', text: r.text, createdAt: r.created_at };
  }

  post(user, room, raw) {
    this.requireRoom(room);
    const text = cleanMessage(raw);
    const now = Date.now();
    const recent = (this.sent.get(user.id) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_COUNT) throw new ChatError(429, 'You are sending messages too fast. Wait a few seconds.');
    recent.push(now);
    this.sent.set(user.id, recent);
    const id = Number(this.q.insert.run(room, user.id, text, now).lastInsertRowid);
    this.q.setRead.run(user.id, room, id); // your own message is read by you
    const message = this.shape(this.q.byId.get(id));
    this.publish(room, { t: 'msg', room, message });
    return message;
  }

  list(room, { before, after, limit }) {
    this.requireRoom(room);
    if (after) return { messages: this.q.after.all(room, after).map((r) => this.shape(r)), hasMore: false };
    const n = Math.max(1, Math.min(100, limit || PAGE));
    const rows = this.q.before.all(room, before || Number.MAX_SAFE_INTEGER, n + 1);
    const hasMore = rows.length > n;
    return { messages: rows.slice(0, n).reverse().map((r) => this.shape(r)), hasMore };
  }

  remove(user, id) {
    const row = this.q.byId.get(id);
    if (!row || row.deleted) throw new ChatError(404, 'Message not found');
    if (row.user_id !== user.id && user.role !== 'admin') throw new ChatError(403, 'You can only delete your own messages');
    this.q.softDelete.run(id);
    this.publish(row.room, { t: 'del', room: row.room, id });
    return { room: row.room };
  }

  markRead(userId, room, lastId) {
    this.requireRoom(room);
    const id = Math.min(Number(lastId) || 0, this.q.maxId.get(room).n);
    if (id > 0) this.q.setRead.run(userId, room, id);
  }

  unread(userId) {
    const out = {};
    for (const r of this.q.unread.all({ me: userId })) out[r.room] = r.n;
    return out;
  }

  members() {
    return this.q.members.all();
  }

  // A map was deleted: its discussion goes with it.
  dropRoom(room) {
    this.q.dropRoom.run(room);
    this.q.dropReads.run(room);
    for (const c of this.conns) if (c.rooms.delete(room)) this.send(c, { t: 'gone', room });
  }

  /* ---------- websocket (push only) ---------- */

  send(c, msg) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  publish(room, msg, except) {
    const data = JSON.stringify(msg);
    for (const c of this.conns) if (c !== except && c.rooms.has(room) && c.ws.readyState === 1) c.ws.send(data);
  }

  presence(room) {
    const seen = new Map();
    for (const c of this.conns) if (c.rooms.has(room) && !seen.has(c.user.id)) seen.set(c.user.id, { id: c.user.id, name: c.user.name, color: c.user.color });
    this.publish(room, { t: 'presence', room, users: Array.from(seen.values()) });
  }

  kickUser(userId, reason = 'Signed out') {
    for (const c of this.conns) if (c.user.id === userId) c.ws.close(4401, reason);
  }

  handleUpgrade(req, socket, head) {
    const reject = (code, msg) => {
      try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ }
      socket.destroy();
    };
    if (!this.originAllowed(req)) return reject(403, 'Forbidden');
    const sess = this.sessionFromCookie(req.headers.cookie);
    if (!sess) return reject(401, 'Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws, sess.user));
  }

  connect(ws, user) {
    const conn = { ws, user, rooms: new Set(), alive: true, tokens: 20, last: Date.now(), typingAt: new Map() };
    this.conns.add(conn);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (raw) => {
      try { this.message(conn, raw); } catch { /* ignore a bad message */ }
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      for (const room of conn.rooms) this.presence(room);
    });
    ws.on('error', () => { /* handled by close */ });
    this.send(conn, { t: 'hello' });
  }

  message(conn, raw) {
    const now = Date.now();
    conn.tokens = Math.min(20, conn.tokens + ((now - conn.last) / 1000) * 5);
    conn.last = now;
    if (conn.tokens < 1) return;
    conn.tokens -= 1;
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!this.q.userActive.get(conn.user.id)) return conn.ws.close(4401, 'Signed out');
    if (m.t === 'sub') {
      if (!Array.isArray(m.rooms) || m.rooms.length > MAX_ROOMS_PER_SOCKET) return;
      const before = new Set(conn.rooms);
      conn.rooms = new Set(m.rooms.filter((r) => this.roomAllowed(r)));
      this.send(conn, { t: 'subscribed', rooms: Array.from(conn.rooms) });
      for (const room of new Set([...before, ...conn.rooms])) this.presence(room);
    } else if (m.t === 'typing') {
      if (!conn.rooms.has(m.room)) return;
      if (now - (conn.typingAt.get(m.room) || 0) < 1500) return;
      conn.typingAt.set(m.room, now);
      this.publish(m.room, { t: 'typing', room: m.room, user: { id: conn.user.id, name: conn.user.name } }, conn);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
    this.wss.close();
  }
}

module.exports = { Chat, ChatError };
