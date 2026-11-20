'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/doc.js');
const ai = require('../src/ai');
const { start } = require('./helper');

const note = (doc, id, text) => D.applyOp(doc, { type: 'note', id, text });
function small() {
  const doc = D.newDoc('Root');
  D.applyOp(doc, { type: 'add', id: 'aaaa', parent: doc.rootId, text: 'Email', x: 0, y: 0 });
  D.applyOp(doc, { type: 'add', id: 'bbbb', parent: 'aaaa', text: 'Welcome series', x: 0, y: 60 });
  return doc;
}

/* ---------- descriptions in the engine ---------- */

test('description: write, change, clear, and every step undoes', () => {
  const doc = small();
  assert.equal(doc.nodes.aaaa.note, undefined);
  const a = note(doc, 'aaaa', '  Monthly newsletter to existing customers.  ');
  assert.equal(doc.nodes.aaaa.note, 'Monthly newsletter to existing customers.');
  const b = note(doc, 'aaaa', 'Line one\nLine two');
  assert.equal(doc.nodes.aaaa.note, 'Line one\nLine two', 'line breaks are kept');
  const c = note(doc, 'aaaa', '');
  assert.equal('note' in doc.nodes.aaaa, false, 'clearing removes it');
  for (const r of [c, b, a].map((x) => x.inverse)) assert.ok(D.applyOp(doc, r).ok);
  assert.equal('note' in doc.nodes.aaaa, false, 'back to no description');
});

test('description: cleaned, limited, and bad input is refused untouched', () => {
  const doc = small();
  note(doc, 'aaaa', 'a\u0000b\u0007c \n\n\n\n\n\nd   \n  e');
  assert.equal(doc.nodes.aaaa.note, 'abc\n\n\nd\n  e');
  note(doc, 'aaaa', '<img src=x onerror=alert(1)>');
  assert.equal(doc.nodes.aaaa.note, '<img src=x onerror=alert(1)>', 'kept as text; the page only shows it with textContent');
  const before = JSON.stringify(doc);
  for (const op of [
    { type: 'note', id: 'nope', text: 'x' }, { type: 'note', id: 'aaaa' }, { type: 'note', id: 'aaaa', text: 5 },
    { type: 'note', id: 'aaaa', text: 'x'.repeat(2001) }, { type: 'note', text: 'x' }, { type: 'note', id: '__proto__', text: 'x' },
  ]) assert.equal(D.applyOp(doc, op).ok, false, JSON.stringify(op));
  assert.equal(JSON.stringify(doc), before);
  assert.equal(note(doc, 'aaaa', 'x'.repeat(2000)).ok, true);
  assert.ok(D.isClientOp({ type: 'note', id: 'aaaa', text: 'x' }));
});

test('description: adding an idea with one, deleting and restoring keeps it', () => {
  const doc = small();
  assert.ok(D.applyOp(doc, { type: 'add', id: 'cccc', parent: 'aaaa', text: 'Promo', x: 0, y: 120, note: ' Q4 offer ' }).ok);
  assert.equal(doc.nodes.cccc.note, 'Q4 offer');
  assert.equal(D.applyOp(doc, { type: 'add', id: 'dddd', parent: 'aaaa', text: 'x', x: 0, y: 0, note: 'y'.repeat(2001) }).ok, false);
  assert.equal(D.applyOp(doc, { type: 'add', id: 'dddd', parent: 'aaaa', text: 'x', x: 0, y: 0, note: 7 }).ok, false);
  assert.equal('note' in (D.applyOp(doc, { type: 'add', id: 'eeee', parent: 'aaaa', text: 'plain', x: 0, y: 0, note: '  ' }).ok ? doc.nodes.eeee : {}), false, 'a blank description is not stored');
  note(doc, 'bbbb', 'Five emails over two weeks');
  const del = D.applyOp(doc, { type: 'delete', id: 'aaaa' });
  assert.ok(del.ok);
  assert.ok(D.applyOp(doc, del.inverse).ok);
  assert.equal(doc.nodes.bbbb.note, 'Five emails over two weeks', 'undoing a delete brings the descriptions back');
  assert.equal(doc.nodes.cccc.note, 'Q4 offer');
  assert.ok(D.validDoc(doc));
});

test('description: copied with a duplicated branch, exported, imported, searchable', () => {
  const doc = small();
  note(doc, 'bbbb', 'Five emails over two weeks');
  const dup = D.duplicateBranch(doc, 'aaaa');
  const next = D.clone(doc);
  assert.ok(D.applyOp(next, dup.op).ok);
  const copy = D.subtreeIds(next, dup.newRoot).map((id) => next.nodes[id]).find((n) => n.text === 'Welcome series');
  assert.equal(copy.note, 'Five emails over two weeks');

  const tree = D.toTree(doc, 'T');
  const welcome = tree.root.children[0].children[0];
  assert.equal(welcome.note, 'Five emails over two weeks');
  assert.equal('note' in tree.root.children[0], false, 'no empty note keys');
  const back = D.fromTree(JSON.parse(JSON.stringify(tree)));
  assert.equal(Object.values(back.nodes).find((n) => n.text === 'Welcome series').note, 'Five emails over two weeks');
  const messy = D.fromTree({ format: 'idea-map', root: { text: 'r', note: 7, children: [{ text: 'a', note: 'z'.repeat(3000) }, { text: 'b', note: '  ' }, { text: 'c', note: 'ok' }] } });
  const by = (t) => Object.values(messy.nodes).find((n) => n.text === t);
  assert.equal(by('r').note, undefined);
  assert.equal(by('a').note.length, 2000);
  assert.equal(by('b').note, undefined);
  assert.equal(by('c').note, 'ok');

  assert.deepEqual(D.search(doc, 'two weeks'), ['bbbb'], 'find in map looks inside descriptions');
  assert.match(D.searchText(doc, 'T'), /five emails over two weeks/);
});

/* ---------- live and saved ---------- */

async function world() {
  const s = await start();
  const admin = await s.setupAdmin();
  const editor = await s.invite(admin, 'editor', 'ed@example.com', 'Ed');
  const viewer = await s.invite(admin, 'viewer', 'v@example.com', 'Vi');
  const map = (await admin.api('POST', '/api/maps', { template: 'campaign' })).json.map;
  const doc = async () => (await admin.api('GET', `/api/maps/${map.id}`)).json.doc;
  const ideaId = async (text) => Object.values((await doc()).nodes).find((n) => n.text === text).id;
  return { s, admin, editor, viewer, map, doc, ideaId };
}

test('descriptions are live, saved, exported and findable; viewers cannot write them', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const id = await w.ideaId('Email');
  const e = await w.s.connect(w.editor, w.map.id);
  const v = await w.s.connect(w.viewer, w.map.id);
  e.sendJson({ t: 'op', cid: 'n1', op: { type: 'note', id, text: 'Our monthly newsletter' } });
  assert.equal((await v.waitFor((m) => m.t === 'op')).op.text, 'Our monthly newsletter');
  v.sendJson({ t: 'op', cid: 'v1', op: { type: 'note', id, text: 'defaced' } });
  assert.match((await v.waitFor((m) => m.t === 'reject')).error, /view-only/);
  e.close();
  v.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await w.doc()).nodes[id].note, 'Our monthly newsletter');
  assert.equal((await w.admin.api('GET', '/api/maps?q=monthly%20newsletter')).json.maps.length, 1, 'the library search finds it');
  const exp = (await w.admin.api('GET', `/api/maps/${w.map.id}/export`)).json;
  const email = exp.root.children.flatMap(function f(c) { return [c, ...c.children.flatMap(f)]; }).find((c) => c.text === 'Email');
  assert.equal(email.note, 'Our monthly newsletter');
});

/* ---------- comments ---------- */

const post = (who, mapId, nodeId, text) => who.api('POST', `/api/maps/${mapId}/nodes/${nodeId}/comments`, { text });
const thread = (who, mapId, nodeId) => who.api('GET', `/api/maps/${mapId}/nodes/${nodeId}/comments`);

test('everyone signed in can comment on an idea, including viewers; strangers cannot', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const id = await w.ideaId('Email');
  for (const who of [w.admin, w.editor, w.viewer]) assert.equal((await post(who, w.map.id, id, 'From ' + who.user.name)).status, 200);
  const list = (await thread(w.viewer, w.map.id, id)).json.comments;
  assert.deepEqual(list.map((c) => c.name), ['Ada Admin', 'Ed', 'Vi']);
  assert.deepEqual(list.map((c) => c.text), ['From Ada Admin', 'From Ed', 'From Vi'], 'oldest first');
  assert.ok(list.every((c) => c.nodeId === id && c.createdAt && c.color && !('email' in c)));
  assert.equal((await w.s.req('GET', `/api/maps/${w.map.id}/nodes/${id}/comments`)).status, 401);
  assert.equal((await w.s.req('POST', `/api/maps/${w.map.id}/nodes/${id}/comments`, { body: { text: 'x' } })).status, 401);
  assert.equal((await w.s.req('POST', `/api/maps/${w.map.id}/nodes/${id}/comments`, { body: { text: 'x' }, cookie: w.editor.cookie })).status, 403, 'CSRF token required');
  assert.equal((await w.s.req('GET', `/api/maps/${w.map.id}/comments`)).status, 401);
});

test('comments are kept per idea, with counts for the board', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const email = await w.ideaId('Email');
  const search = await w.ideaId('Search');
  await post(w.editor, w.map.id, email, 'one');
  await post(w.editor, w.map.id, email, 'two');
  await post(w.viewer, w.map.id, search, 'three');
  assert.deepEqual((await w.admin.api('GET', `/api/maps/${w.map.id}/comments`)).json.counts, { [email]: 2, [search]: 1 });
  assert.deepEqual((await thread(w.admin, w.map.id, search)).json.comments.map((c) => c.text), ['three']);
  assert.deepEqual((await thread(w.admin, w.map.id, await w.ideaId('Offer'))).json.comments, []);
});

test('comment validation and the unknown-map and unknown-idea cases', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const id = await w.ideaId('Email');
  for (const bad of ['', '  \n ', undefined, 5, null]) assert.equal((await post(w.editor, w.map.id, id, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await post(w.editor, w.map.id, id, 'x'.repeat(2001))).status, 400);
  const html = '<img src=x onerror=alert(1)> & "q"';
  assert.equal((await post(w.editor, w.map.id, id, html)).json.comment.text, html, 'stored as typed; the page shows it as text');
  assert.equal((await post(w.editor, w.map.id, 'doesnotexist1', 'x')).status, 404);
  assert.equal((await post(w.editor, 'nomapnomapno', id, 'x')).status, 404);
  assert.equal((await thread(w.editor, w.map.id, 'doesnotexist1')).status, 404);
  assert.equal((await w.admin.api('GET', '/api/maps/nomapnomapno/comments')).status, 404);
  assert.equal((await w.admin.api('GET', `/api/maps/${w.map.id}/nodes/..%2F..%2Fx/comments`)).status, 404);
});

test('comments: delete your own, admins delete any, nobody else; rate limited', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const id = await w.ideaId('Email');
  const mine = (await post(w.editor, w.map.id, id, 'mine')).json.comment;
  const theirs = (await post(w.admin, w.map.id, id, 'admins')).json.comment;
  assert.equal((await w.viewer.api('DELETE', `/api/comments/${mine.id}`)).status, 403);
  assert.equal((await w.editor.api('DELETE', `/api/comments/${theirs.id}`)).status, 403);
  assert.equal((await w.editor.api('DELETE', `/api/comments/${mine.id}`)).status, 200);
  assert.equal((await w.editor.api('DELETE', `/api/comments/${mine.id}`)).status, 404);
  assert.equal((await w.s.req('DELETE', `/api/comments/${theirs.id}`)).status, 401);
  const v = (await post(w.viewer, w.map.id, id, 'viewer says')).json.comment;
  assert.equal((await w.admin.api('DELETE', `/api/comments/${v.id}`)).status, 200, 'admin moderates');
  assert.deepEqual((await thread(w.admin, w.map.id, id)).json.comments.map((c) => c.text), ['admins']);
  assert.deepEqual((await w.admin.api('GET', `/api/maps/${w.map.id}/comments`)).json.counts, { [id]: 1 }, 'deleted comments are not counted');
  let last;
  for (let i = 0; i < 11; i++) last = await post(w.editor, w.map.id, id, 'spam ' + i); // 1 earlier + 11 = the 12 allowed
  assert.equal(last.status, 200);
  const limited = await post(w.editor, w.map.id, id, 'too many');
  assert.equal(limited.status, 429);
  assert.match(limited.json.error, /too fast/);
});

test('new and deleted comments are pushed live to everyone with that map open, and only them', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const other = (await w.admin.api('POST', '/api/maps', { template: 'blank' })).json.map;
  const id = await w.ideaId('Email');
  const a = await w.s.connect(w.admin, w.map.id);
  const v = await w.s.connect(w.viewer, w.map.id);
  const elsewhere = await w.s.connect(w.admin, other.id);
  const c = (await post(w.editor, w.map.id, id, 'live one')).json.comment;
  for (const ws of [a, v]) {
    const m = await ws.waitFor((x) => x.t === 'comment');
    assert.equal(m.nodeId, id);
    assert.equal(m.comment.text, 'live one');
    assert.equal(m.comment.name, 'Ed');
  }
  await w.editor.api('DELETE', `/api/comments/${c.id}`);
  for (const ws of [a, v]) {
    const m = await ws.waitFor((x) => x.t === 'comment-del');
    assert.deepEqual([m.nodeId, m.id], [id, c.id]);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(elsewhere.hello.map.id, other.id);
  [a, v, elsewhere].forEach((x) => x.close());
});

test('comments stay when an idea is deleted and come back when the deletion is undone', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const id = await w.ideaId('Email');
  await post(w.editor, w.map.id, id, 'worth keeping');
  const e = await w.s.connect(w.admin, w.map.id);
  e.sendJson({ t: 'op', cid: 'd1', op: { type: 'delete', id } });
  await e.waitFor((m) => m.cid === 'd1');
  assert.equal((await thread(w.admin, w.map.id, id)).status, 404, 'no thread for an idea that is gone');
  e.sendJson({ t: 'undo' });
  await e.waitFor((m) => m.t === 'op' && !m.cid);
  assert.deepEqual((await thread(w.admin, w.map.id, id)).json.comments.map((c) => c.text), ['worth keeping']);
  e.close();
});

test('deleting a map removes its comments; a removed person shows as Former member', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const id = await w.ideaId('Email');
  await post(w.editor, w.map.id, id, 'gone soon');
  await w.admin.api('DELETE', `/api/admin/users/${w.editor.user.id}`);
  assert.equal((await thread(w.admin, w.map.id, id)).json.comments[0].name, 'Former member');
  assert.equal((await w.admin.api('DELETE', `/api/maps/${w.map.id}`)).status, 200);
  assert.equal(w.s.app.db.prepare('SELECT COUNT(*) AS n FROM idea_comments').get().n, 0);
});

/* ---------- Claude ---------- */

test('Claude sees descriptions and can write, change and clear them as one undoable step', () => {
  const doc = small();
  note(doc, 'aaaa', 'Monthly\nnewsletter');
  const ctx = ai.buildContext(doc, 'T', null);
  assert.match(ctx.text, /\[n1\] "Email" — description: "Monthly newsletter"/);
  assert.ok(!/\[n2\] "Welcome series" —/.test(ctx.text), 'no description line when there is none');
  assert.match(ai.SYSTEM_PROMPT, /action "describe"/);
  const ref = (id) => [...ctx.refs].find(([, v]) => v === id)[0];
  const ch = (o) => ({ action: 'add', ref: '', parent: '', text: '', color: '', ...o });
  const out = ai.translate(doc, { reply: 'ok', tidy: false, changes: [
    ch({ action: 'describe', ref: ref('bbbb'), text: 'A five-email onboarding sequence sent over two weeks.' }),
    ch({ action: 'describe', ref: ref('aaaa'), text: '' }),
    ch({ action: 'describe', ref: 'n999', text: 'unknown idea' }),
    ch({ action: 'describe', ref: ref('bbbb'), text: 'x'.repeat(5000) }),
  ] }, ctx.refs);
  assert.deepEqual(out.changes.map((c) => c.kind), ['describe', 'describe', 'describe']);
  assert.equal(out.skipped, 1);
  const next = D.clone(doc);
  const applied = D.applyOp(next, out.ops);
  assert.ok(applied.ok);
  assert.equal(next.nodes.bbbb.note.length, 1000, 'long descriptions are shortened to 1,000 characters');
  assert.equal('note' in next.nodes.aaaa, false, 'an empty text clears it');
  assert.ok(D.applyOp(next, applied.inverse).ok);
  assert.deepEqual(next, doc);
});
