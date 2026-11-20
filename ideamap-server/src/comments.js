'use strict';
const { ChatError, cleanMessage } = require('./chat');

/*
 * Comments on ideas. Each idea in a map has its own thread. Everyone who is signed in can read and write,
 * viewers included (this is conversation, not editing the map). You can delete your own comments and admins
 * can delete any. New and deleted comments are pushed live to everyone who has the map open.
 */
const RATE_COUNT = 12;
const RATE_WINDOW_MS = 20000;

class Comments {
  constructor({ db, push }) {
    this.push = push; // (mapId, message) => void
    this.sent = new Map();
    this.q = {
      insert: db.prepare('INSERT INTO idea_comments (map_id, node_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)'),
      byId: db.prepare('SELECT c.id, c.map_id, c.node_id, c.user_id, c.text, c.created_at, c.deleted, u.name, u.color FROM idea_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?'),
      list: db.prepare('SELECT c.id, c.map_id, c.node_id, c.user_id, c.text, c.created_at, u.name, u.color FROM idea_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.map_id = ? AND c.node_id = ? AND c.deleted = 0 ORDER BY c.id ASC LIMIT 500'),
      counts: db.prepare('SELECT node_id, COUNT(*) AS n FROM idea_comments WHERE map_id = ? AND deleted = 0 GROUP BY node_id'),
      softDelete: db.prepare('UPDATE idea_comments SET deleted = 1 WHERE id = ?'),
    };
  }

  shape(r) {
    return { id: r.id, mapId: r.map_id, nodeId: r.node_id, userId: r.user_id, name: r.name || 'Former member', color: r.color || '#5c7080', text: r.text, createdAt: r.created_at };
  }

  counts(mapId) {
    const out = {};
    for (const r of this.q.counts.all(mapId)) out[r.node_id] = r.n;
    return out;
  }

  list(mapId, nodeId) {
    return this.q.list.all(mapId, nodeId).map((r) => this.shape(r));
  }

  post(user, mapId, nodeId, raw) {
    const text = cleanMessage(raw);
    const now = Date.now();
    const recent = (this.sent.get(user.id) || []).filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_COUNT) throw new ChatError(429, 'You are commenting too fast. Wait a few seconds.');
    recent.push(now);
    this.sent.set(user.id, recent);
    const id = Number(this.q.insert.run(mapId, nodeId, user.id, text, now).lastInsertRowid);
    const comment = this.shape(this.q.byId.get(id));
    this.push(mapId, { t: 'comment', nodeId, comment });
    return comment;
  }

  remove(user, id) {
    const row = this.q.byId.get(id);
    if (!row || row.deleted) throw new ChatError(404, 'Comment not found');
    if (row.user_id !== user.id && user.role !== 'admin') throw new ChatError(403, 'You can only delete your own comments');
    this.q.softDelete.run(id);
    this.push(row.map_id, { t: 'comment-del', nodeId: row.node_id, id });
  }
}

module.exports = { Comments };
