'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'ideamap.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
      color TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS maps (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      search_text TEXT NOT NULL DEFAULT '',
      node_count INTEGER NOT NULL DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 0,
      owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS maps_updated ON maps(updated_at DESC);
    CREATE TABLE IF NOT EXISTS folds (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      ids TEXT NOT NULL,
      PRIMARY KEY (user_id, map_id)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS chat_room_id ON chat_messages(room, id);
    CREATE TABLE IF NOT EXISTS idea_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idea_comments_node ON idea_comments(map_id, node_id, id);
    CREATE TABLE IF NOT EXISTS chat_reads (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room TEXT NOT NULL,
      last_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, room)
    );
  `);
  return db;
}

module.exports = { open };
