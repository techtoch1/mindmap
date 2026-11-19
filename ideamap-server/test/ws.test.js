'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helper');

async function world() {
  const s = await start();
  const admin = await s.setupAdmin();
  const editor = await s.invite(admin, 'editor', 'ed@example.com', 'Ed');
  const viewer = await s.invite(admin, 'viewer', 'v@example.com', 'Vi');
  const map = (await admin.api('POST', '/api/maps', { template: 'swot' })).json.map;
  return { s, admin, editor, viewer, map };
}
const rejectsWith = (p, status) => assert.rejects(p, (e) => e.status === status);

test('websocket requires a session, an allowed origin and an existing map', async (t) => {
  const { s, admin, map } = await world();
  t.after(() => s.close());
  await rejectsWith(s.connect(null, map.id, { cookie: '' }), 401);
  await rejectsWith(s.connect(admin, map.id, { origin: 'https://evil.example' }), 403);
  await rejectsWith(s.connect(admin, map.id, { origin: null }), 403);
  await rejectsWith(s.connect(admin, 'does-not-exist'), 404);
  const ws = await s.connect(admin, map.id);
  assert.equal(ws.hello.you.role, 'admin');
  assert.equal(ws.hello.doc.nodes[ws.hello.doc.rootId].text, 'SWOT');
  ws.close();
});

test('edits are applied, acknowledged to the sender and broadcast to everyone else', async (t) => {
  const { s, admin, editor, map } = await world();
  t.after(() => s.close());
  const a = await s.connect(admin, map.id);
  const b = await s.connect(editor, map.id);
  await a.waitFor((m) => m.t === 'join');
  assert.equal(b.hello.peers.length, 1);
  const rootId = a.hello.doc.rootId;
  a.sendJson({ t: 'op', cid: 'c1', op: { type: 'add', id: 'newnode01', parent: rootId, text: 'Fresh idea', x: 10, y: 20 } });
  const echoA = await a.waitFor((m) => m.t === 'op' && m.cid === 'c1');
  const seenB = await b.waitFor((m) => m.t === 'op');
  assert.equal(echoA.v, seenB.v);
  assert.equal(seenB.op.text, 'Fresh idea');
  assert.equal(seenB.by, admin.user.id);
  // a late joiner gets the edit in the snapshot
  const c = await s.connect(admin, map.id);
  assert.equal(c.hello.doc.nodes.newnode01.text, 'Fresh idea');
  assert.equal(c.hello.v, echoA.v);
  [a, b, c].forEach((w) => w.close());
});

test('edits are persisted to SQLite and survive everyone leaving', async (t) => {
  const { s, admin, map } = await world();
  t.after(() => s.close());
  const a = await s.connect(admin, map.id);
  const rootId = a.hello.doc.rootId;
  a.sendJson({ t: 'op', cid: 'c1', op: { type: 'text', id: rootId, text: 'Persisted title' } });
  await a.waitFor((m) => m.t === 'op');
  a.close();
  await new Promise((r) => setTimeout(r, 150));
  const got = await admin.api('GET', `/api/maps/${map.id}`);
  assert.equal(got.json.doc.nodes[rootId].text, 'Persisted title');
  assert.equal((await admin.api('GET', '/api/maps?q=persisted')).json.maps.length, 1);
});

test('viewers can watch but their edits are refused and never reach anyone', async (t) => {
  const { s, admin, viewer, map } = await world();
  t.after(() => s.close());
  const a = await s.connect(admin, map.id);
  const v = await s.connect(viewer, map.id);
  assert.equal(v.hello.you.role, 'viewer');
  v.sendJson({ t: 'op', cid: 'v1', op: { type: 'text', id: a.hello.doc.rootId, text: 'defaced' } });
  const rej = await v.waitFor((m) => m.t === 'reject' && m.cid === 'v1');
  assert.match(rej.error, /view-only/);
  v.sendJson({ t: 'undo' });
  await assert.rejects(a.waitFor((m) => m.t === 'op', 300));
  // but cursors and selections are shared
  v.sendJson({ t: 'cursor', x: 5, y: 6 });
  const cur = await a.waitFor((m) => m.t === 'cursor');
  assert.equal(cur.x, 5);
  [a, v].forEach((w) => w.close());
});

test('a user demoted while connected loses write access immediately', async (t) => {
  const { s, admin, editor, map } = await world();
  t.after(() => s.close());
  const e = await s.connect(editor, map.id);
  e.sendJson({ t: 'op', cid: 'e1', op: { type: 'text', id: e.hello.doc.rootId, text: 'ok' } });
  await e.waitFor((m) => m.t === 'op');
  await admin.api('PATCH', `/api/admin/users/${editor.user.id}`, { role: 'viewer' });
  e.sendJson({ t: 'op', cid: 'e2', op: { type: 'text', id: e.hello.doc.rootId, text: 'sneaky' } });
  await e.waitFor((m) => m.t === 'reject' && m.cid === 'e2');
  e.close();
});

test('disabling a user disconnects their open sockets', async (t) => {
  const { s, admin, editor, map } = await world();
  t.after(() => s.close());
  const e = await s.connect(editor, map.id);
  const closed = new Promise((r) => e.on('close', (code) => r(code)));
  await admin.api('PATCH', `/api/admin/users/${editor.user.id}`, { disabled: true });
  assert.equal(await closed, 4401);
});

test('invalid and malicious operations are rejected without changing the map', async (t) => {
  const { s, admin, map } = await world();
  t.after(() => s.close());
  const a = await s.connect(admin, map.id);
  const rootId = a.hello.doc.rootId;
  const bad = [
    { type: 'delete', id: rootId },
    { type: 'restore', nodes: [], parent: rootId },
    { type: 'text', id: rootId, text: 'x'.repeat(10000) },
    { type: 'add', id: '../etc', parent: rootId, text: '', x: 0, y: 0 },
    { type: '__proto__' },
    { type: 'batch', ops: [{ type: 'batch', ops: [] }] },
  ];
  let n = 0;
  for (const op of bad) {
    const cid = 'bad' + n++;
    a.sendJson({ t: 'op', cid, op });
    await a.waitFor((m) => m.t === 'reject' && m.cid === cid);
  }
  a.send('this is not json');
  a.send(JSON.stringify({ t: 'op', cid: 5, op: null }));
  a.send(JSON.stringify({ t: 'select', ids: 'nope' }));
  const fresh = await s.connect(admin, map.id);
  assert.equal(fresh.hello.v, 0);
  assert.equal(Object.keys(fresh.hello.doc.nodes).length, 5);
  [a, fresh].forEach((w) => w.close());
});

test('undo and redo only touch your own changes', async (t) => {
  const { s, admin, editor, map } = await world();
  t.after(() => s.close());
  const a = await s.connect(admin, map.id);
  const b = await s.connect(editor, map.id);
  const rootId = a.hello.doc.rootId;
  const kids = a.hello.doc.nodes[rootId].children;
  a.sendJson({ t: 'op', cid: 'a1', op: { type: 'text', id: kids[0], text: 'Ada was here' } });
  await a.waitFor((m) => m.t === 'op' && m.cid === 'a1');
  b.sendJson({ t: 'op', cid: 'b1', op: { type: 'text', id: kids[1], text: 'Ed was here' } });
  await b.waitFor((m) => m.t === 'op' && m.cid === 'b1');

  a.sendJson({ t: 'undo' });
  const undone = await b.waitFor((m) => m.t === 'op' && m.op.type === 'text' && m.op.id === kids[0] && m.by === admin.user.id && !m.cid);
  assert.equal(undone.op.text, 'Strengths');
  // Ada has nothing else to undo - Ed's change is untouched
  a.sendJson({ t: 'undo' });
  assert.match((await a.waitFor((m) => m.t === 'notice')).message, /Nothing to undo/);

  a.sendJson({ t: 'redo' });
  const redone = await b.waitFor((m) => m.t === 'op' && m.op.id === kids[0] && m.op.text === 'Ada was here');
  assert.ok(redone);

  // delete a subtree, then undo brings it back
  a.sendJson({ t: 'op', cid: 'a2', op: { type: 'delete', id: kids[2] } });
  await a.waitFor((m) => m.t === 'op' && m.cid === 'a2');
  a.sendJson({ t: 'undo' });
  const restored = await b.waitFor((m) => m.t === 'op' && m.op.type === 'restore');
  assert.equal(restored.op.nodes[0].id, kids[2]);
  const fresh = await s.connect(admin, map.id);
  assert.ok(fresh.hello.doc.nodes[kids[2]]);
  assert.equal(fresh.hello.doc.nodes[kids[1]].text, 'Ed was here');
  [a, b, fresh].forEach((w) => w.close());
});

test('undo is skipped safely when someone else already removed the node', async (t) => {
  const { s, admin, editor, map } = await world();
  t.after(() => s.close());
  const a = await s.connect(admin, map.id);
  const b = await s.connect(editor, map.id);
  const kid = a.hello.doc.nodes[a.hello.doc.rootId].children[0];
  a.sendJson({ t: 'op', cid: 'a1', op: { type: 'text', id: kid, text: 'edited' } });
  await a.waitFor((m) => m.cid === 'a1');
  b.sendJson({ t: 'op', cid: 'b1', op: { type: 'delete', id: kid } });
  await b.waitFor((m) => m.cid === 'b1');
  a.sendJson({ t: 'undo' });
  assert.match((await a.waitFor((m) => m.t === 'notice')).message, /no longer/);
  [a, b].forEach((w) => w.close());
});

test('presence: join, leave, cursors and selections', async (t) => {
  const { s, admin, editor, map } = await world();
  t.after(() => s.close());
  const a = await s.connect(admin, map.id);
  const b = await s.connect(editor, map.id);
  const joined = await a.waitFor((m) => m.t === 'join');
  assert.equal(joined.peer.name, 'Ed');
  assert.ok(joined.peer.color);
  b.sendJson({ t: 'cursor', x: 100, y: 200 });
  const cur = await a.waitFor((m) => m.t === 'cursor');
  assert.deepEqual([cur.c, cur.x, cur.y], [joined.peer.c, 100, 200]);
  const kid = a.hello.doc.nodes[a.hello.doc.rootId].children[0];
  b.sendJson({ t: 'select', ids: [kid, 'nonexistent'] });
  const sel = await a.waitFor((m) => m.t === 'select');
  assert.deepEqual(sel.ids, [kid]);
  b.close();
  const left = await a.waitFor((m) => m.t === 'leave');
  assert.equal(left.c, joined.peer.c);
  a.close();
});

test('per-person fold state is stored per user, not shared', async (t) => {
  const { s, admin, editor, map } = await world();
  t.after(() => s.close());
  const a = await s.connect(admin, map.id);
  const kid = a.hello.doc.nodes[a.hello.doc.rootId].children[0];
  a.sendJson({ t: 'fold', ids: [kid] });
  await new Promise((r) => setTimeout(r, 100));
  a.close();
  const a2 = await s.connect(admin, map.id);
  assert.deepEqual(a2.hello.folds, [kid]);
  const b = await s.connect(editor, map.id);
  assert.deepEqual(b.hello.folds, []);
  [a2, b].forEach((w) => w.close());
});

test('renaming and deleting a map are pushed to people who have it open', async (t) => {
  const { s, admin, editor, map } = await world();
  t.after(() => s.close());
  const b = await s.connect(editor, map.id);
  await admin.api('PATCH', `/api/maps/${map.id}`, { title: 'New name' });
  assert.equal((await b.waitFor((m) => m.t === 'title')).title, 'New name');
  const closed = new Promise((r) => b.on('close', (code) => r(code)));
  await admin.api('DELETE', `/api/maps/${map.id}`);
  assert.equal(await closed, 4404);
});
