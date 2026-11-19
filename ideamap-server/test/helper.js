'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { load } = require('../src/config');
const { createApp } = require('../src/app');

async function start(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamap-test-'));
  const config = load({ DATA_DIR: dataDir, ...env });
  const app = createApp(config);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;

  function req(method, url, { body, cookie, csrf, headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
      const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : method === 'GET' || method === 'DELETE' ? undefined : '{}';
      const h = { Host: host, ...headers };
      if (method !== 'GET' && !('x-idea-map' in h)) h['x-idea-map'] = '1';
      if (data !== undefined && !('content-type' in h)) h['content-type'] = 'application/json';
      if (cookie) h.cookie = cookie;
      if (csrf) h['x-csrf-token'] = csrf;
      const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch { /* not json */ }
          const sc = res.headers['set-cookie'];
          resolve({ status: res.statusCode, json, text, headers: res.headers, cookie: sc ? sc[0].split(';')[0] : undefined });
        });
      });
      r.on('error', reject);
      if (data !== undefined) r.write(data);
      r.end();
    });
  }

  // A signed-in session: { cookie, csrf, user, api(method,url,body) }
  function wrap(cookie, csrf, user) {
    const s = { cookie, csrf, user };
    s.api = (method, url, body) => req(method, url, { body, cookie, csrf });
    return s;
  }

  async function setupAdmin(email = 'admin@example.com', password = 'correct horse battery') {
    const r = await req('POST', '/api/setup', { body: { name: 'Ada Admin', email, password } });
    if (r.status !== 200) throw new Error('setup failed ' + r.text);
    return wrap(r.cookie, r.json.csrf, r.json.user);
  }

  async function invite(admin, role, email, name = 'Invitee') {
    const inv = await admin.api('POST', '/api/admin/invites', { role });
    const r = await req('POST', `/api/invites/${inv.json.token}/accept`, { body: { name, email, password: 'another long password' } });
    if (r.status !== 200) throw new Error('accept failed ' + r.text);
    return wrap(r.cookie, r.json.csrf, r.json.user);
  }

  function connect(session, mapId, { origin: o = origin, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const headers = {};
      if (o) headers.Origin = o;
      const ck = cookie === undefined ? session && session.cookie : cookie;
      if (ck) headers.Cookie = ck;
      const ws = new WebSocket(`ws://${host}/ws?map=${mapId}`, { headers });
      const inbox = [];
      const waiters = [];
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        const i = waiters.findIndex((w) => w.pred(m));
        if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
        else inbox.push(m);
      });
      ws.waitFor = (pred, ms = 2000) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
          waiters.push({ pred, resolve: (m) => { clearTimeout(t); res(m); } });
        });
      };
      ws.sendJson = (m) => ws.send(JSON.stringify(m));
      ws.on('unexpected-response', (_q, res) => reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode })));
      ws.on('error', (e) => reject(e));
      ws.on('open', async () => {
        try {
          ws.hello = await ws.waitFor((m) => m.t === 'hello');
          resolve(ws);
        } catch (e) { reject(e); }
      });
    });
  }

  return {
    app, config, port, host, origin, dataDir, req, wrap, setupAdmin, invite, connect,
    async close() {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

module.exports = { start };
