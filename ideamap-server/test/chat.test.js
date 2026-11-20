'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { start } = require('./helper');

async function world() {
  const s = await start();
  const admin = await s.setupAdmin();
  const editor = await s.invite(admin, 'editor', 'ed@example.com', 'Ed');
  const viewer = await s.invite(admin, 'viewer', 'v@example.com', 'Vi');
  const map = (await admin.api('POST', '/api/maps', { template: 'blank' })).json.map;
  return { s, admin, editor, viewer, map };
}
const say = (who, room, text) => who.api('POST', `/api/chat/rooms/${room}/messages`, { text });
const history = (who, room, qs = '') => who.api('GET', `/api/chat/rooms/${room}/messages${qs}`);

function connectChat(s, session, { origin = s.origin, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (origin) headers.Origin = origin;
    const ck = cookie === undefined ? session && session.cookie : cookie;
    if (ck) headers.Cookie = ck;
    const ws = new WebSocket(`ws://${s.host}/ws/chat`, { headers });
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
    ws.none = async (pred, ms = 300) => {
      await new Promise((r) => setTimeout(r, ms));
      assert.equal(inbox.some(pred), false, 'unexpected message received');
    };
    ws.sendJson = (m) => ws.send(JSON.stringify(m));
    ws.sub = async (...rooms) => { ws.sendJson({ t: 'sub', rooms }); return ws.waitFor((m) => m.t === 'subscribed'); };
    ws.on('unexpected-response', (_q, res) => reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode })));
    ws.on('error', reject);
    ws.on('open', () => resolve(ws));
  });
}

test('everyone signed in can chat, viewers too; strangers cannot', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  for (const who of [w.admin, w.editor, w.viewer]) assert.equal((await say(who, 'team', 'hello from ' + who.user.name)).status, 200);
  assert.equal((await history(w.viewer, 'team')).json.messages.length, 3);
  assert.equal((await w.s.req('GET', '/api/chat/rooms/team/messages')).status, 401);
  assert.equal((await w.s.req('POST', '/api/chat/rooms/team/messages', { body: { text: 'x' } })).status, 401);
  assert.equal((await w.s.req('POST', '/api/chat/rooms/team/messages', { body: { text: 'x' }, cookie: w.editor.cookie })).status, 403, 'CSRF token required');
  assert.equal((await w.s.req('GET', '/api/chat/members')).status, 401);
  assert.equal((await w.s.req('GET', '/api/chat/unread')).status, 401);
});

test('messages carry the author, are saved in order, and the API returns raw text', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const html = '<img src=x onerror=alert(1)> & "quotes"';
  const r = await say(w.editor, 'team', `  ${html}  `);
  assert.equal(r.json.message.text, html, 'trimmed, otherwise stored as typed (the UI only uses textContent)');
  assert.equal(r.json.message.name, 'Ed');
  assert.equal(r.json.message.userId, w.editor.user.id);
  assert.match(r.json.message.color, /^#/);
  assert.equal(typeof r.json.message.createdAt, 'number');
  await say(w.admin, 'team', 'second');
  const h = (await history(w.admin, 'team')).json;
  assert.deepEqual(h.messages.map((m) => m.text), [html, 'second']);
  assert.equal(h.hasMore, false);
});

test('message validation: empty, too long, control characters, blank lines', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  for (const bad of ['', '   \n  ', undefined, 5, {}, null]) assert.equal((await say(w.editor, 'team', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await say(w.editor, 'team', 'x'.repeat(2001))).status, 400);
  assert.equal((await say(w.editor, 'team', 'x'.repeat(2000))).status, 200);
  const r = await say(w.editor, 'team', 'a\u0000b\u0007c\r\n\n\n\n\n\nd');
  assert.equal(r.json.message.text, 'abc\n\n\nd');
});

test('rooms: team, an existing map, and nothing else', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const room = 'map-' + w.map.id;
  assert.equal((await say(w.editor, room, 'about this map')).status, 200);
  assert.equal((await history(w.viewer, room)).json.messages[0].text, 'about this map');
  assert.equal((await history(w.viewer, 'team')).json.messages.length, 0, 'rooms are separate');
  for (const bad of ['map-doesnotexist', 'general', 'map-', 'map-../etc', 'TEAM']) {
    assert.equal((await say(w.editor, bad, 'x')).status, 404, bad);
    assert.equal((await history(w.editor, bad)).status, 404, bad);
  }
  assert.equal((await w.admin.api('GET', '/api/chat/rooms/..%2F..%2Fx/messages')).status, 404);
});

test('history pages: latest first, older on request, new ones since a message', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const db = w.s.app.db;
  const ins = db.prepare('INSERT INTO chat_messages (room, user_id, text, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 1; i <= 120; i++) ins.run('team', w.admin.user.id, 'm' + i, Date.now() + i);
  const page1 = (await history(w.editor, 'team')).json;
  assert.equal(page1.messages.length, 50);
  assert.equal(page1.messages[0].text, 'm71');
  assert.equal(page1.messages.at(-1).text, 'm120');
  assert.equal(page1.hasMore, true);
  const page2 = (await history(w.editor, 'team', `?before=${page1.messages[0].id}`)).json;
  assert.equal(page2.messages[0].text, 'm21');
  assert.equal(page2.messages.at(-1).text, 'm70');
  assert.equal(page2.hasMore, true);
  const page3 = (await history(w.editor, 'team', `?before=${page2.messages[0].id}`)).json;
  assert.deepEqual([page3.messages.length, page3.hasMore], [20, false]);
  const since = (await history(w.editor, 'team', `?after=${page1.messages[47].id}`)).json;
  assert.deepEqual(since.messages.map((m) => m.text), ['m119', 'm120']);
  assert.equal((await history(w.editor, 'team', '?limit=5')).json.messages.length, 5);
  assert.equal((await history(w.editor, 'team', '?limit=9999')).json.messages.length, 100, 'capped');
  assert.equal((await history(w.editor, 'team', '?before=abc&limit=-3')).status, 200, 'junk parameters are ignored');
});

test('you can delete your own messages; admins can delete anyone\'s; nobody else can', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const mine = (await say(w.editor, 'team', 'mine')).json.message;
  const theirs = (await say(w.admin, 'team', 'admins')).json.message;
  assert.equal((await w.viewer.api('DELETE', `/api/chat/messages/${mine.id}`)).status, 403);
  assert.equal((await w.editor.api('DELETE', `/api/chat/messages/${theirs.id}`)).status, 403);
  assert.equal((await w.editor.api('DELETE', `/api/chat/messages/${mine.id}`)).status, 200);
  assert.equal((await w.editor.api('DELETE', `/api/chat/messages/${mine.id}`)).status, 404, 'already gone');
  assert.equal((await w.admin.api('DELETE', `/api/chat/messages/99999`)).status, 404);
  assert.equal((await w.s.req('DELETE', `/api/chat/messages/${theirs.id}`)).status, 401);
  const other = (await say(w.viewer, 'team', 'viewer says')).json.message;
  assert.equal((await w.admin.api('DELETE', `/api/chat/messages/${other.id}`)).status, 200, 'admin moderates');
  assert.deepEqual((await history(w.admin, 'team')).json.messages.map((m) => m.text), ['admins']);
});

test('sending too fast is limited per person', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  let last;
  for (let i = 0; i < 12; i++) last = await say(w.editor, 'team', 'spam ' + i);
  assert.equal(last.status, 200);
  const blocked = await say(w.editor, 'team', 'one too many');
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error, /too fast/);
  assert.equal((await say(w.viewer, 'team', 'someone else is fine')).status, 200);
});

test('unread counts per room, cleared by reading, never counting your own messages', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const room = 'map-' + w.map.id;
  await say(w.admin, 'team', 'a');
  await say(w.admin, 'team', 'b');
  const last = (await say(w.admin, 'team', 'c')).json.message;
  await say(w.admin, room, 'about the map');
  assert.deepEqual((await w.editor.api('GET', '/api/chat/unread')).json.unread, { team: 3, [room]: 1 });
  assert.deepEqual((await w.admin.api('GET', '/api/chat/unread')).json.unread, {}, 'your own messages are read');
  assert.equal((await w.editor.api('POST', '/api/chat/rooms/team/read', { lastId: last.id - 1 })).status, 200);
  assert.deepEqual((await w.editor.api('GET', '/api/chat/unread')).json.unread, { team: 1, [room]: 1 });
  await w.editor.api('POST', '/api/chat/rooms/team/read', { lastId: last.id });
  await w.editor.api('POST', '/api/chat/rooms/team/read', { lastId: 1 }); // never goes backwards
  assert.deepEqual((await w.editor.api('GET', '/api/chat/unread')).json.unread, { [room]: 1 });
  await w.editor.api('POST', `/api/chat/rooms/${room}/read`, { lastId: 999999 }); // clamped to what exists
  assert.deepEqual((await w.editor.api('GET', '/api/chat/unread')).json.unread, {});
  assert.equal((await w.editor.api('POST', '/api/chat/rooms/nope/read', { lastId: 1 })).status, 404);
  // deleted messages stop counting
  const m = (await say(w.admin, 'team', 'oops')).json.message;
  assert.equal((await w.editor.api('GET', '/api/chat/unread')).json.unread.team, 1);
  await w.admin.api('DELETE', `/api/chat/messages/${m.id}`);
  assert.deepEqual((await w.editor.api('GET', '/api/chat/unread')).json.unread, {});
});

test('members list is for names and colours only, never emails or roles', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const r = await w.viewer.api('GET', '/api/chat/members');
  assert.deepEqual(r.json.members.map((m) => m.name).sort(), ['Ada Admin', 'Ed', 'Vi']);
  assert.doesNotMatch(r.text, /@|admin@|role|password/);
  await w.admin.api('PATCH', `/api/admin/users/${w.editor.user.id}`, { disabled: true });
  assert.ok(!(await w.viewer.api('GET', '/api/chat/members')).json.members.some((m) => m.name === 'Ed'), 'disabled people are not listed');
});

test('websocket needs a session and an allowed origin', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  await assert.rejects(connectChat(w.s, null, { cookie: '' }), (e) => e.status === 401);
  await assert.rejects(connectChat(w.s, w.admin, { origin: 'https://evil.example' }), (e) => e.status === 403);
  await assert.rejects(connectChat(w.s, w.admin, { origin: null }), (e) => e.status === 403);
  const ws = await connectChat(w.s, w.admin);
  ws.close();
});

test('new messages are pushed live to people who joined that room, and only them', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const room = 'map-' + w.map.id;
  const a = await connectChat(w.s, w.admin);
  const b = await connectChat(w.s, w.editor);
  const c = await connectChat(w.s, w.viewer);
  assert.deepEqual((await a.sub('team', room)).rooms, ['team', room]);
  await b.sub('team');
  await c.sub(room);
  await say(w.editor, 'team', 'to the team');
  for (const ws of [a, b]) {
    const m = await ws.waitFor((x) => x.t === 'msg');
    assert.equal(m.room, 'team');
    assert.equal(m.message.text, 'to the team');
    assert.equal(m.message.name, 'Ed');
  }
  await c.none((x) => x.t === 'msg');
  await say(w.viewer, room, 'about the map');
  for (const ws of [a, c]) assert.equal((await ws.waitFor((x) => x.t === 'msg')).message.text, 'about the map');
  await b.none((x) => x.t === 'msg' && x.room === room);
  [a, b, c].forEach((x) => x.close());
});

test('joining a room you may not see is ignored', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const a = await connectChat(w.s, w.admin);
  const sub = await a.sub('team', 'map-doesnotexist', 'general', '../x');
  assert.deepEqual(sub.rooms, ['team']);
  a.sendJson({ t: 'sub', rooms: new Array(10).fill('team') });
  a.sendJson({ t: 'sub', rooms: 'nope' });
  a.send('not json');
  await new Promise((r) => setTimeout(r, 150));
  a.close();
});

test('presence: who is in a room right now, deduplicated by person', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const a = await connectChat(w.s, w.admin);
  await a.sub('team');
  assert.deepEqual((await a.waitFor((m) => m.t === 'presence')).users.map((u) => u.name), ['Ada Admin']);
  const b = await connectChat(w.s, w.editor);
  await b.sub('team');
  const both = await a.waitFor((m) => m.t === 'presence' && m.users.length === 2);
  assert.deepEqual(both.users.map((u) => u.name).sort(), ['Ada Admin', 'Ed']);
  assert.ok(both.users.every((u) => u.color && !('email' in u)));
  const b2 = await connectChat(w.s, w.editor); // the same person in a second tab
  await b2.sub('team');
  await new Promise((r) => setTimeout(r, 150));
  b.close();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await history(w.admin, 'team')).status, 200);
  b2.close();
  const left = await a.waitFor((m) => m.t === 'presence' && m.users.length === 1 && m.users[0].name === 'Ada Admin');
  assert.ok(left);
  a.close();
});

test('typing is shown to the others in the room, not to yourself, and is throttled', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const a = await connectChat(w.s, w.admin);
  const b = await connectChat(w.s, w.editor);
  await a.sub('team');
  await b.sub('team');
  b.sendJson({ t: 'typing', room: 'team' });
  const typing = await a.waitFor((m) => m.t === 'typing');
  assert.equal(typing.user.name, 'Ed');
  assert.equal(typing.room, 'team');
  b.sendJson({ t: 'typing', room: 'team' });
  b.sendJson({ t: 'typing', room: 'team' });
  await a.none((m) => m.t === 'typing', 250);
  await b.none((m) => m.t === 'typing', 100);
  const lonely = await connectChat(w.s, w.viewer);
  lonely.sendJson({ t: 'typing', room: 'team' }); // not joined: ignored
  await a.none((m) => m.t === 'typing' && m.user.name === 'Vi', 250);
  [a, b, lonely].forEach((x) => x.close());
});

test('deleting a message is pushed live', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const a = await connectChat(w.s, w.viewer);
  await a.sub('team');
  const m = (await say(w.editor, 'team', 'regret')).json.message;
  await a.waitFor((x) => x.t === 'msg');
  await w.editor.api('DELETE', `/api/chat/messages/${m.id}`);
  const d = await a.waitFor((x) => x.t === 'del');
  assert.deepEqual([d.room, d.id], ['team', m.id]);
  a.close();
});

test('deleting a map deletes its discussion and tells people in it', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const room = 'map-' + w.map.id;
  await say(w.editor, room, 'hello map');
  const a = await connectChat(w.s, w.viewer);
  await a.sub('team', room);
  assert.equal((await w.admin.api('DELETE', `/api/maps/${w.map.id}`)).status, 200);
  assert.equal((await a.waitFor((m) => m.t === 'gone')).room, room);
  assert.equal((await history(w.admin, room)).status, 404);
  assert.equal(w.s.app.db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE room = ?').get(room).n, 0);
  assert.deepEqual((await w.admin.api('GET', '/api/chat/unread')).json.unread, {});
  a.close();
});

test('disabling or removing someone disconnects their chat, and removed people\'s messages stay', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  await say(w.editor, 'team', 'I was here');
  const e = await connectChat(w.s, w.editor);
  await e.sub('team');
  const closed = new Promise((r) => e.on('close', (code) => r(code)));
  await w.admin.api('PATCH', `/api/admin/users/${w.editor.user.id}`, { disabled: true });
  assert.equal(await closed, 4401);
  assert.equal((await say(w.editor, 'team', 'still here?')).status, 401, 'session is gone too');
  await w.admin.api('DELETE', `/api/admin/users/${w.editor.user.id}`);
  const msgs = (await history(w.admin, 'team')).json.messages;
  assert.deepEqual(msgs.map((m) => [m.text, m.name]), [['I was here', 'Former member']]);
});

test('chat tables survive a restart of the database connection', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  await say(w.editor, 'team', 'persisted');
  const row = w.s.app.db.prepare("SELECT text FROM chat_messages WHERE room = 'team'").get();
  assert.equal(row.text, 'persisted');
});

test('a new team member starts with the old chat history already read', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  for (let i = 0; i < 5; i++) await say(w.admin, 'team', 'old ' + i);
  assert.equal((await w.editor.api('GET', '/api/chat/unread')).json.unread.team, 5, 'existing members still have them unread');
  const newbie = await w.s.invite(w.admin, 'editor', 'new@example.com', 'Newbie');
  assert.deepEqual((await newbie.api('GET', '/api/chat/unread')).json.unread, {}, 'but a brand-new account starts caught up');
  assert.equal((await history(newbie, 'team')).json.messages.length, 5, 'and can still scroll back through the history');
  await say(w.admin, 'team', 'first message after joining');
  assert.equal((await newbie.api('GET', '/api/chat/unread')).json.unread.team, 1);
});
