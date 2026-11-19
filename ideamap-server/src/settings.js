'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/*
 * Small key/value store for admin settings. Secrets (the Anthropic API key) are encrypted with
 * AES-256-GCM using a random key kept in DATA_DIR/secret.key (mode 600), separate from the database
 * file. A copy of the database alone, such as a backup, therefore does not contain a usable key.
 * Back up secret.key together with ideamap.db if you want saved settings to survive a restore.
 */
function open(db, dataDir) {
  const keyFile = path.join(dataDir, 'secret.key');
  let key;
  try {
    key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  } catch {
    key = null;
  }
  if (!key || key.length !== 32) {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600 });
  }

  db.exec('CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const q = {
    get: db.prepare('SELECT value FROM settings WHERE name = ?'),
    set: db.prepare('INSERT INTO settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'),
    del: db.prepare('DELETE FROM settings WHERE name = ?'),
  };

  const b64 = (b) => b.toString('base64');
  function encrypt(plain) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return 'v1:' + [iv, c.getAuthTag(), enc].map(b64).join(':');
  }
  function decrypt(stored) {
    try {
      const [v, iv, tag, enc] = String(stored).split(':');
      if (v !== 'v1') return null;
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
    } catch {
      return null; // wrong key file or tampered value
    }
  }

  return {
    get(name) {
      const r = q.get.get(name);
      return r ? r.value : null;
    },
    set(name, value) {
      q.set.run(name, String(value), Date.now());
    },
    getSecret(name) {
      const r = q.get.get(name);
      return r ? decrypt(r.value) : null;
    },
    setSecret(name, value) {
      q.set.run(name, encrypt(String(value)), Date.now());
    },
    delete(name) {
      q.del.run(name);
    },
  };
}

module.exports = { open };
