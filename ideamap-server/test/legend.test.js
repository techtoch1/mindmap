'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/doc.js');
const { start } = require('./helper');
const ai = require('../src/ai');

const set = (doc, color, label) => D.applyOp(doc, { type: 'legend', color, label });

test('legend: name a colour, rename it, clear it; every step undoes', () => {
  const doc = D.newDoc('Root');
  assert.deepEqual(doc.legend, {});
  const a = set(doc, 'blue', '  Channels   and  platforms ');
  assert.ok(a.ok);
  assert.deepEqual(doc.legend, { blue: 'Channels and platforms' }, 'trimmed and spaces collapsed');
  const b = set(doc, 'blue', 'Channels');
  assert.deepEqual(doc.legend, { blue: 'Channels' });
  const c = set(doc, 'default', 'Not sorted yet');
  assert.deepEqual(doc.legend, { blue: 'Channels', default: 'Not sorted yet' }, 'the plain colour can be named too');
  const d = set(doc, 'blue', '');
  assert.deepEqual(doc.legend, { default: 'Not sorted yet' }, 'an empty name clears it');
  for (const r of [d, c, b, a].map((x) => x.inverse)) assert.ok(D.applyOp(doc, r).ok);
  assert.deepEqual(doc.legend, {}, 'back to nothing');
});

test('legend: bad input is refused and leaves the map untouched', () => {
  const doc = D.newDoc('Root');
  set(doc, 'green', 'Done');
  const before = JSON.stringify(doc);
  for (const op of [
    { type: 'legend', color: 'pink', label: 'x' },
    { type: 'legend', color: '__proto__', label: 'x' },
    { type: 'legend', color: 'constructor', label: 'x' },
    { type: 'legend', label: 'x' },
    { type: 'legend', color: 'red' },
    { type: 'legend', color: 'red', label: 5 },
    { type: 'legend', color: 'red', label: 'x'.repeat(41) },
  ]) assert.equal(D.applyOp(doc, op).ok, false, JSON.stringify(op));
  assert.equal(JSON.stringify(doc), before);
  assert.equal(set(doc, 'red', 'x'.repeat(40)).ok, true, '40 characters is the limit');
  assert.equal(({}).polluted, undefined);
});

test('legend: control characters are stripped, other text is stored as typed', () => {
  const doc = D.newDoc('Root');
  set(doc, 'amber', 'A\u0000B\u0007C <b>x</b>');
  assert.equal(doc.legend.amber, 'ABC <b>x</b>');
});

test('legend operations are allowed from browsers and batch with colour changes as one undo', () => {
  assert.ok(D.isClientOp({ type: 'legend', color: 'blue', label: 'x' }));
  const doc = D.newDoc('Root');
  D.applyOp(doc, { type: 'add', id: 'aaaa', parent: doc.rootId, text: 'Email', x: 0, y: 0 });
  const before = D.clone(doc);
  const r = D.applyOp(doc, { type: 'batch', ops: [{ type: 'color', id: 'aaaa', color: 'blue' }, { type: 'legend', color: 'blue', label: 'Channels' }] });
  assert.ok(r.ok);
  assert.equal(doc.nodes.aaaa.color, 'blue');
  assert.equal(doc.legend.blue, 'Channels');
  assert.ok(D.applyOp(doc, r.inverse).ok);
  assert.deepEqual(doc, before);
});

test('maps saved before the colour key existed still work', () => {
  const old = { rootId: 'rrrr', nodes: { rrrr: { id: 'rrrr', parent: null, text: 'Old', x: 0, y: 0, color: 'default', children: [] } } };
  assert.ok(D.validDoc(old));
  assert.ok(set(old, 'teal', 'Ideas').ok);
  assert.deepEqual(old.legend, { teal: 'Ideas' });
  assert.deepEqual(D.toTree({ rootId: 'rrrr', nodes: old.nodes }, 'x').legend, {});
});

test('export and import keep the colour key; junk in a file is ignored', () => {
  const doc = D.newDoc('Root');
  set(doc, 'blue', 'Channels');
  set(doc, 'green', 'Done');
  const tree = D.toTree(doc, 'Map');
  assert.deepEqual(tree.legend, { blue: 'Channels', green: 'Done' });
  assert.deepEqual(D.fromTree(JSON.parse(JSON.stringify(tree))).legend, { blue: 'Channels', green: 'Done' });
  const hostile = D.fromTree({ format: 'idea-map', root: { text: 'r' }, legend: { blue: 'x'.repeat(100), pink: 'no', __proto__: 'x', green: 5, red: '  ', teal: 'ok' } });
  assert.deepEqual(hostile.legend, { blue: 'x'.repeat(40), teal: 'ok' });
  assert.deepEqual(D.fromTree({ format: 'idea-map', root: { text: 'r' }, legend: ['a'] }).legend, {});
  assert.deepEqual(D.fromTree({ format: 'idea-map', root: { text: 'r' } }).legend, {});
});

test('colour names are searchable with the map', () => {
  const doc = D.newDoc('Root');
  set(doc, 'purple', 'Webinar ideas');
  assert.match(D.searchText(doc, 'Title'), /webinar ideas/);
});

/* ---------- through the server ---------- */

async function world() {
  const s = await start();
  const admin = await s.setupAdmin();
  const editor = await s.invite(admin, 'editor', 'ed@example.com', 'Ed');
  const viewer = await s.invite(admin, 'viewer', 'v@example.com', 'Vi');
  const map = (await admin.api('POST', '/api/maps', { template: 'blank' })).json.map;
  return { s, admin, editor, viewer, map };
}

test('the colour key is live, saved, exported, imported and copied with the map', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const a = await w.s.connect(w.editor, w.map.id);
  const b = await w.s.connect(w.viewer, w.map.id);
  assert.deepEqual(a.hello.doc.legend, {});
  a.sendJson({ t: 'op', cid: 'l1', op: { type: 'legend', color: 'blue', label: 'Channels' } });
  const seen = await b.waitFor((m) => m.t === 'op');
  assert.deepEqual(seen.op, { type: 'legend', color: 'blue', label: 'Channels' });
  a.close();
  b.close();
  await new Promise((r) => setTimeout(r, 200));
  const loaded = (await w.admin.api('GET', `/api/maps/${w.map.id}`)).json.doc;
  assert.deepEqual(loaded.legend, { blue: 'Channels' }, 'saved');
  const exp = (await w.admin.api('GET', `/api/maps/${w.map.id}/export`)).json;
  assert.deepEqual(exp.legend, { blue: 'Channels' }, 'exported');
  const imp = await w.admin.api('POST', '/api/maps/import', { data: exp });
  assert.deepEqual((await w.admin.api('GET', `/api/maps/${imp.json.map.id}`)).json.doc.legend, { blue: 'Channels' }, 'imported');
  const dup = await w.admin.api('POST', `/api/maps/${w.map.id}/duplicate`);
  assert.deepEqual((await w.admin.api('GET', `/api/maps/${dup.json.map.id}`)).json.doc.legend, { blue: 'Channels' }, 'duplicated');
  assert.equal((await w.admin.api('GET', '/api/maps?q=channels')).json.maps.length >= 1, true, 'findable by the colour name');
});

test('viewers cannot rename colours, and undo brings back your last name', async (t) => {
  const w = await world();
  t.after(() => w.s.close());
  const v = await w.s.connect(w.viewer, w.map.id);
  v.sendJson({ t: 'op', cid: 'v1', op: { type: 'legend', color: 'red', label: 'Nope' } });
  assert.match((await v.waitFor((m) => m.t === 'reject')).error, /view-only/);
  const e = await w.s.connect(w.editor, w.map.id);
  e.sendJson({ t: 'op', cid: 'e1', op: { type: 'legend', color: 'red', label: 'Urgent' } });
  await e.waitFor((m) => m.cid === 'e1');
  e.sendJson({ t: 'op', cid: 'e2', op: { type: 'legend', color: 'red', label: 'Blocked' } });
  await e.waitFor((m) => m.cid === 'e2');
  e.sendJson({ t: 'undo' });
  const undone = await e.waitFor((m) => m.t === 'op' && !m.cid);
  assert.deepEqual(undone.op, { type: 'legend', color: 'red', label: 'Urgent' });
  e.sendJson({ t: 'op', cid: 'e3', op: { type: 'legend', color: 'red', label: 'x'.repeat(41) } });
  await e.waitFor((m) => m.t === 'reject' && m.cid === 'e3');
  [v, e].forEach((x) => x.close());
});

/* ---------- Claude ---------- */

test('Claude is shown the colour key', () => {
  const doc = D.newDoc('Root');
  assert.match(ai.buildContext(doc, 'T', null).text, /Colour key: \(no colour has a name yet\)/);
  set(doc, 'blue', 'Channels');
  set(doc, 'green', 'Done "really"');
  const text = ai.buildContext(doc, 'T', null).text;
  assert.match(text, /Colour key: blue = "Channels"; green = "Done \\"really\\""/);
  assert.ok(text.indexOf('Colour key') < text.indexOf('</map>'), 'inside the data block');
  assert.match(ai.SYSTEM_PROMPT, /colour key/);
  assert.match(ai.SYSTEM_PROMPT, /action "legend"/);
});

test('Claude can name colours, in the same proposal as colouring ideas, as one undo', () => {
  const doc = D.newDoc('Root');
  D.applyOp(doc, { type: 'add', id: 'aaaa', parent: doc.rootId, text: 'Email', x: 0, y: 0 });
  D.applyOp(doc, { type: 'add', id: 'bbbb', parent: doc.rootId, text: 'Podcast', x: 0, y: 60 });
  const { refs } = ai.buildContext(doc, 'T', null);
  const ref = (id) => [...refs].find(([, v]) => v === id)[0];
  const ch = (o) => ({ action: 'add', ref: '', parent: '', text: '', color: '', ...o });
  const out = ai.translate(doc, { reply: 'ok', tidy: false, changes: [
    ch({ action: 'color', ref: ref('aaaa'), color: 'blue' }),
    ch({ action: 'color', ref: ref('bbbb'), color: 'purple' }),
    ch({ action: 'legend', color: 'blue', text: 'Owned channels' }),
    ch({ action: 'legend', color: 'purple', text: 'Audio and video' }),
    ch({ action: 'legend', color: 'pink', text: 'bad colour' }),
    ch({ action: 'legend', color: 'red', text: '' }),
    ch({ action: 'legend', color: 'teal', text: 'x'.repeat(100) }),
  ] }, refs);
  assert.deepEqual(out.changes.map((c) => c.kind), ['color', 'color', 'legend', 'legend', 'legend', 'legend']);
  assert.equal(out.changes[2].label, 'Name the blue colour “Owned channels”');
  assert.equal(out.skipped, 1, 'only the invalid colour is skipped');
  const next = D.clone(doc);
  const applied = D.applyOp(next, out.ops);
  assert.ok(applied.ok);
  assert.equal(next.legend.blue, 'Owned channels');
  assert.equal(next.legend.teal.length, 40, 'long names are shortened to the limit');
  assert.equal(next.nodes.aaaa.color, 'blue');
  assert.ok(D.applyOp(next, applied.inverse).ok);
  assert.deepEqual(next, doc);
});
