'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/doc.js');
const { start } = require('./helper');

// Names every JavaScript object "has" by inheritance. Idea ids come from other people's browsers, so none of
// these may ever be treated as an idea, and no operation may write onto the shared base object.
const HOSTILE = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];
const baseline = () => JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort());
const clean = () => ['text', 'note', 'x', 'y', 'dx', 'dy', 'color', 'parent', 'children', 'id', 'label'].every((k) => ({})[k] === undefined);

function doc() {
  const d = D.newDoc('Root');
  D.applyOp(d, { type: 'add', id: 'aaaa', parent: d.rootId, text: 'A', x: 0, y: 0 });
  return d;
}

test('no operation can write onto inherited names such as __proto__ or constructor', () => {
  const before = baseline();
  const d = doc();
  const snapshot = JSON.stringify(d);
  for (const id of HOSTILE) {
    const ops = [
      { type: 'text', id, text: 'pwned' }, { type: 'color', id, color: 'red' }, { type: 'move', id, dx: 5, dy: 5 },
      { type: 'note', id, text: 'pwned' }, { type: 'delete', id }, { type: 'reparent', id, parent: 'aaaa' },
      { type: 'reparent', id: 'aaaa', parent: id }, { type: 'add', id: 'bbbb', parent: id, text: 'x', x: 0, y: 0 },
      { type: 'add', id, parent: 'aaaa', text: 'x', x: 0, y: 0 },
      { type: 'restore', parent: id, nodes: [{ id: 'cccc', parent: id, text: 'x', x: 0, y: 0, color: 'default', children: [] }] },
      { type: 'restore', parent: 'aaaa', nodes: [{ id, parent: 'aaaa', text: 'x', x: 0, y: 0, color: 'default', children: [] }] },
      JSON.parse(`{"type":"layout","pos":{${JSON.stringify(id)}:[1,2]}}`),
      { type: 'batch', ops: [{ type: 'text', id: 'aaaa', text: 'changed first' }, { type: 'note', id, text: 'pwned' }] },
    ];
    for (const op of ops) assert.equal(D.applyOp(d, op).ok, false, `${id}: ${JSON.stringify(op).slice(0, 80)}`);
  }
  assert.equal(JSON.stringify(d), snapshot, 'the map is untouched, and the failed batch rolled back');
  assert.ok(clean(), 'nothing leaked onto plain objects');
  assert.equal(baseline(), before, 'the shared base object is unchanged');
});

test('hostile names are also refused inside imports, pastes and searches', () => {
  const before = baseline();
  const tree = JSON.parse('{"format":"idea-map","root":{"text":"r","__proto__":{"polluted":1},"children":[{"text":"a","note":"n","__proto__":{"x":1}}]},"legend":{"__proto__":"x","constructor":"y","blue":"ok"}}');
  const imported = D.fromTree(tree);
  assert.deepEqual(imported.legend, { blue: 'ok' });
  assert.ok(D.validDoc(imported));
  assert.ok(clean() && ({}).polluted === undefined);
  const d = doc();
  assert.equal(D.opsFromOutline(d, '__proto__', '- x').error, 'Select an idea to paste under');
  assert.equal(D.duplicateBranch(d, '__proto__').error, 'Idea not found');
  assert.deepEqual(D.search(d, '__proto__'), []);
  assert.equal(baseline(), before);
});

test('ideas whose ids are ordinary still work (guard does not over-block)', () => {
  const d = doc();
  assert.ok(D.applyOp(d, { type: 'text', id: 'aaaa', text: 'fine' }).ok);
  assert.ok(D.applyOp(d, { type: 'note', id: 'aaaa', text: 'fine' }).ok);
  assert.ok(D.applyOp(d, { type: 'layout', pos: { aaaa: [4, 5] } }).ok);
  assert.ok(D.applyOp(d, { type: 'add', id: 'Zq_-09Ab', parent: 'aaaa', text: 'x', x: 0, y: 0 }).ok);
  assert.ok(D.applyOp(d, { type: 'add', id: '_____-----', parent: 'aaaa', text: 'underscores and dashes are fine', x: 0, y: 0 }).ok);
});

test('over the wire: hostile ids are rejected, filtered from selections and folds, and never get comments', async (t) => {
  const before = baseline();
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const editor = await s.invite(admin, 'editor', 'ed@example.com', 'Ed');
  const map = (await admin.api('POST', '/api/maps', { template: 'blank' })).json.map;
  const a = await s.connect(editor, map.id);
  const b = await s.connect(admin, map.id);
  for (const id of ['__proto__', 'constructor']) {
    a.sendJson({ t: 'op', cid: 'x' + id, op: { type: 'text', id, text: 'pwned' } });
    await a.waitFor((m) => m.t === 'reject' && m.cid === 'x' + id);
    a.sendJson({ t: 'op', cid: 'y' + id, op: JSON.parse(`{"type":"layout","pos":{${JSON.stringify(id)}:[1,2]}}`) });
    await a.waitFor((m) => m.t === 'reject' && m.cid === 'y' + id);
    assert.equal((await editor.api('POST', `/api/maps/${map.id}/nodes/${id}/comments`, { text: 'x' })).status, 404);
    assert.equal((await editor.api('GET', `/api/maps/${map.id}/nodes/${id}/comments`)).status, 404);
  }
  a.sendJson({ t: 'select', ids: ['__proto__', 'constructor', a.hello.doc.rootId] });
  assert.deepEqual((await b.waitFor((m) => m.t === 'select')).ids, [a.hello.doc.rootId], 'only real ideas are shared');
  a.sendJson({ t: 'fold', ids: ['__proto__', a.hello.doc.rootId] });
  await new Promise((r) => setTimeout(r, 150));
  a.close();
  const again = await s.connect(editor, map.id);
  assert.deepEqual(again.hello.folds, [again.hello.doc.rootId]);
  again.close();
  b.close();
  assert.ok(clean());
  assert.equal(baseline(), before);
});
