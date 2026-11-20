'use strict';
const { WebSocketServer } = require('ws');
const Doc = require('../public/doc.js');

const FLUSH_MS = 400;
const UNDO_LIMIT = 100;
const MAX_FOLDS = 2000;

/*
 * One Room per open map. The room holds the authoritative document in memory,
 * applies every edit through Doc.applyOp (same code the browser runs), assigns
 * a version number, persists with a short debounce, and broadcasts to peers.
 * Roles are re-read from the database on every message, so demoting or
 * disabling someone takes effect immediately.
 */
class Hub {
  constructor({ db, config, auth }) {
    this.db = db;
    this.config = config;
    this.auth = auth; // { sessionFromCookie(header), checkOrigin(req) }
    this.rooms = new Map();
    this.nextConn = 1;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.q = {
      map: db.prepare('SELECT id, title, data, version FROM maps WHERE id = ?'),
      save: db.prepare('UPDATE maps SET data = ?, search_text = ?, node_count = ?, version = ?, updated_at = ? WHERE id = ?'),
      user: db.prepare('SELECT id, name, color, role, disabled FROM users WHERE id = ?'),
      getFold: db.prepare('SELECT ids FROM folds WHERE user_id = ? AND map_id = ?'),
      setFold: db.prepare('INSERT INTO folds (user_id, map_id, ids) VALUES (?, ?, ?) ON CONFLICT(user_id, map_id) DO UPDATE SET ids = excluded.ids'),
    };
    this.heartbeat = setInterval(() => {
      for (const room of this.rooms.values()) {
        for (const c of room.clients) {
          if (!c.alive) {
            c.ws.terminate();
            continue;
          }
          c.alive = false;
          try { c.ws.ping(); } catch { /* socket gone */ }
        }
      }
    }, 30000);
    this.heartbeat.unref();
  }

  /* ---------- HTTP upgrade ---------- */

  handleUpgrade(req, socket, head) {
    const reject = (code, msg) => {
      try {
        socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch { /* ignore */ }
      socket.destroy();
    };
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return reject(400, 'Bad Request');
    }
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (!this.auth.checkOrigin(req)) return reject(403, 'Forbidden');
    const sess = this.auth.sessionFromCookie(req.headers.cookie);
    if (!sess) return reject(401, 'Unauthorized');
    const mapId = url.searchParams.get('map') || '';
    const room = this._room(mapId);
    if (!room) return reject(404, 'Not Found');
    this.wss.handleUpgrade(req, socket, head, (ws) => this._connect(ws, room, sess.user));
  }

  /* ---------- rooms ---------- */

  _room(mapId) {
    let room = this.rooms.get(mapId);
    if (room) return room;
    const row = this.q.map.get(String(mapId));
    if (!row) return null;
    let doc;
    try {
      doc = JSON.parse(row.data);
    } catch {
      return null;
    }
    if (!Doc.validDoc(doc)) return null;
    room = { id: row.id, title: row.title, doc, version: row.version, clients: new Set(), undo: new Map(), dirty: false, timer: null };
    this.rooms.set(row.id, room);
    return room;
  }

  _markDirty(room) {
    room.dirty = true;
    if (room.timer) return;
    room.timer = setTimeout(() => {
      room.timer = null;
      this._flush(room);
    }, FLUSH_MS);
    room.timer.unref();
  }

  _flush(room) {
    if (room.timer) {
      clearTimeout(room.timer);
      room.timer = null;
    }
    if (!room.dirty) return;
    room.dirty = false;
    this.q.save.run(JSON.stringify(room.doc), Doc.searchText(room.doc, room.title), Doc.count(room.doc), room.version, Date.now(), room.id);
  }

  // Called by REST handlers before they read a map from SQLite.
  flushRoom(mapId) {
    const room = this.rooms.get(mapId);
    if (room) this._flush(room);
  }

  // Push a message to everyone who currently has this map open (comments, for instance).
  pushToMap(mapId, msg) {
    const room = this.rooms.get(mapId);
    if (room) this._broadcast(room, msg);
  }

  renameRoom(mapId, title) {
    const room = this.rooms.get(mapId);
    if (!room) return;
    room.title = title;
    this._broadcast(room, { t: 'title', title });
  }

  closeRoom(mapId, code = 4404, reason = 'Map deleted') {
    const room = this.rooms.get(mapId);
    if (!room) return;
    if (room.timer) clearTimeout(room.timer);
    room.dirty = false;
    this.rooms.delete(mapId);
    for (const c of room.clients) c.ws.close(code, reason);
  }

  kickUser(userId, reason = 'Signed out') {
    for (const room of this.rooms.values()) {
      for (const c of room.clients) if (c.userId === userId) c.ws.close(4401, reason);
    }
  }

  close() {
    clearInterval(this.heartbeat);
    for (const room of this.rooms.values()) {
      this._flush(room);
      for (const c of room.clients) c.ws.terminate();
    }
    this.rooms.clear();
    this.wss.close();
  }

  /* ---------- connections ---------- */

  _send(c, msg) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  _broadcast(room, msg, except) {
    const data = JSON.stringify(msg);
    for (const c of room.clients) if (c !== except && c.ws.readyState === 1) c.ws.send(data);
  }

  _connect(ws, room, user) {
    const conn = {
      ws, room, id: this.nextConn++, userId: user.id, name: user.name, color: user.color,
      alive: true, tokens: 60, last: Date.now(),
    };
    room.clients.add(conn);
    let folds = [];
    try {
      const row = this.q.getFold.get(user.id, room.id);
      if (row) folds = JSON.parse(row.ids);
    } catch { /* ignore bad row */ }
    const peers = [];
    for (const c of room.clients) if (c !== conn) peers.push({ c: c.id, userId: c.userId, name: c.name, color: c.color });
    this._send(conn, {
      t: 'hello',
      you: { c: conn.id, userId: user.id, name: user.name, color: user.color, role: user.role },
      map: { id: room.id, title: room.title },
      doc: room.doc,
      v: room.version,
      folds,
      peers,
    });
    this._broadcast(room, { t: 'join', peer: { c: conn.id, userId: conn.userId, name: conn.name, color: conn.color } }, conn);

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (raw) => {
      try {
        this._message(conn, raw);
      } catch (e) {
        this._send(conn, { t: 'error', error: 'Server error' });
      }
    });
    ws.on('close', () => {
      room.clients.delete(conn);
      this._broadcast(room, { t: 'leave', c: conn.id });
      if (room.clients.size === 0 && this.rooms.get(room.id) === room) {
        this._flush(room);
        this.rooms.delete(room.id);
      }
    });
    ws.on('error', () => { /* handled by close */ });
  }

  _allow(conn) {
    const now = Date.now();
    conn.tokens = Math.min(60, conn.tokens + ((now - conn.last) / 1000) * 40);
    conn.last = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }

  _undoStack(room, userId) {
    let s = room.undo.get(userId);
    if (!s) {
      s = { undo: [], redo: [] };
      room.undo.set(userId, s);
    }
    return s;
  }

  _message(conn, raw) {
    if (!this._allow(conn)) return;
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    const room = conn.room;
    const user = this.q.user.get(conn.userId);
    if (!user || user.disabled) return conn.ws.close(4401, 'Signed out');
    const canEdit = user.role === 'admin' || user.role === 'editor';

    switch (m.t) {
      case 'op': {
        if (!canEdit) return this._send(conn, { t: 'reject', cid: m.cid, error: 'You have view-only access' });
        if (typeof m.cid !== 'string' || m.cid.length > 40) return;
        if (!Doc.isClientOp(m.op)) return this._send(conn, { t: 'reject', cid: m.cid, error: 'Unknown operation' });
        const r = Doc.applyOp(room.doc, m.op);
        if (!r.ok) return this._send(conn, { t: 'reject', cid: m.cid, error: r.error });
        const st = this._undoStack(room, conn.userId);
        st.undo.push(r.inverse);
        if (st.undo.length > UNDO_LIMIT) st.undo.shift();
        st.redo.length = 0;
        room.version++;
        this._markDirty(room);
        this._broadcast(room, { t: 'op', op: m.op, by: conn.userId, c: conn.id, cid: m.cid, v: room.version });
        return;
      }
      case 'undo':
      case 'redo': {
        if (!canEdit) return;
        const st = this._undoStack(room, conn.userId);
        const from = m.t === 'undo' ? st.undo : st.redo;
        const to = m.t === 'undo' ? st.redo : st.undo;
        const op = from.pop();
        if (!op) return this._send(conn, { t: 'notice', message: m.t === 'undo' ? 'Nothing to undo' : 'Nothing to redo' });
        const r = Doc.applyOp(room.doc, op);
        if (!r.ok) return this._send(conn, { t: 'notice', message: 'That change can no longer be ' + (m.t === 'undo' ? 'undone' : 'redone') });
        to.push(r.inverse);
        if (to.length > UNDO_LIMIT) to.shift();
        room.version++;
        this._markDirty(room);
        this._broadcast(room, { t: 'op', op, by: conn.userId, c: conn.id, v: room.version });
        return;
      }
      case 'cursor': {
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
        this._broadcast(room, { t: 'cursor', c: conn.id, x: m.x, y: m.y }, conn);
        return;
      }
      case 'select': {
        if (!Array.isArray(m.ids) || m.ids.length > 20) return;
        const ids = m.ids.filter((id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(room.doc.nodes, id));
        this._broadcast(room, { t: 'select', c: conn.id, ids }, conn);
        return;
      }
      case 'fold': {
        if (!Array.isArray(m.ids) || m.ids.length > MAX_FOLDS) return;
        const ids = m.ids.filter((id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(room.doc.nodes, id));
        this.q.setFold.run(conn.userId, room.id, JSON.stringify(ids));
        return;
      }
      default:
    }
  }
}

module.exports = { Hub };
