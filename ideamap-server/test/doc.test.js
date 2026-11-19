'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../public/doc.js');

function sample() {
  const doc = D.newDoc('Root');
  const r = doc.rootId;
  const add = (id, parent, text, x = 0, y = 0) => assert.ok(D.applyOp(doc, { type: 'add', id, parent, text, x, y }).ok);
  add('aaaa', r, 'A');
  add('bbbb', r, 'B');
  add('cccc', 'aaaa', 'A1');
  add('dddd', 'aaaa', 'A2');
  return doc;
}

test('add / text / color / move with inverses restore the document', () => {
  const doc = sample();
  const before = JSON.stringify(doc);
  const ops = [
    { type: 'add', id: 'eeee', parent: 'bbbb', text: 'B1', x: 5, y: 5 },
    { type: 'text', id: 'aaaa', text: 'Alpha' },
    { type: 'color', id: 'bbbb', color: 'red' },
    { type: 'move', id: 'aaaa', dx: 40, dy: -10 },
  ];
  const inverses = ops.map((o) => {
    const r = D.applyOp(doc, o);
    assert.ok(r.ok, r.error);
    return r.inverse;
  });
  assert.notDeepEqual(doc, JSON.parse(before));
  for (const inv of inverses.reverse()) assert.ok(D.applyOp(doc, inv).ok);
  assert.deepEqual(doc, JSON.parse(before));
});

test('delete removes the subtree and its inverse restores it in place', () => {
  const doc = sample();
  const before = JSON.stringify(doc);
  const r = D.applyOp(doc, { type: 'delete', id: 'aaaa' });
  assert.ok(r.ok);
  assert.equal(D.count(doc), 2);
  assert.ok(D.applyOp(doc, r.inverse).ok);
  assert.deepEqual(doc, JSON.parse(before));
});

test('reparent keeps order, blocks cycles, and inverts', () => {
  const doc = sample();
  assert.equal(D.applyOp(doc, { type: 'reparent', id: 'aaaa', parent: 'cccc' }).ok, false);
  assert.equal(D.applyOp(doc, { type: 'reparent', id: 'aaaa', parent: 'aaaa' }).ok, false);
  assert.equal(D.applyOp(doc, { type: 'reparent', id: doc.rootId, parent: 'aaaa' }).ok, false);
  const before = JSON.stringify(doc);
  const r = D.applyOp(doc, { type: 'reparent', id: 'cccc', parent: 'bbbb', index: 0 });
  assert.ok(r.ok);
  assert.deepEqual(doc.nodes.bbbb.children, ['cccc']);
  assert.deepEqual(doc.nodes.aaaa.children, ['dddd']);
  assert.ok(D.applyOp(doc, r.inverse).ok);
  assert.deepEqual(doc, JSON.parse(before));
});

test('the central idea cannot be deleted', () => {
  const doc = sample();
  assert.equal(D.applyOp(doc, { type: 'delete', id: doc.rootId }).ok, false);
});

test('invalid operations are rejected and leave the document untouched', () => {
  const doc = sample();
  const before = JSON.stringify(doc);
  const bad = [
    { type: 'add', id: 'x', parent: doc.rootId, text: 't', x: 0, y: 0 },
    { type: 'add', id: 'aaaa', parent: doc.rootId, text: 't', x: 0, y: 0 },
    { type: 'add', id: 'ffff', parent: 'nope', text: 't', x: 0, y: 0 },
    { type: 'add', id: 'ffff', parent: doc.rootId, text: 'x'.repeat(501), x: 0, y: 0 },
    { type: 'add', id: 'ffff', parent: doc.rootId, text: 't', x: NaN, y: 0 },
    { type: 'add', id: 'ffff', parent: doc.rootId, text: 't', x: 1e9, y: 0 },
    { type: 'text', id: 'nope', text: 'x' },
    { type: 'text', id: 'aaaa', text: 42 },
    { type: 'color', id: 'aaaa', color: 'hotpink' },
    { type: 'move', id: 'aaaa', dx: 'a', dy: 0 },
    { type: 'move', id: 'aaaa', dx: 1e9, dy: 0 },
    { type: 'layout', pos: { aaaa: [1] } },
    { type: 'layout', pos: { nope: [1, 2] } },
    { type: 'nonsense' },
    { type: '__proto__' },
    null,
  ];
  for (const op of bad) assert.equal(D.applyOp(doc, op).ok, false, JSON.stringify(op));
  assert.deepEqual(doc, JSON.parse(before));
});

test('batch is all-or-nothing', () => {
  const doc = sample();
  const before = JSON.stringify(doc);
  const r = D.applyOp(doc, { type: 'batch', ops: [
    { type: 'text', id: 'aaaa', text: 'changed' },
    { type: 'delete', id: 'bbbb' },
    { type: 'text', id: 'bbbb', text: 'gone' }, // fails: bbbb was deleted
  ] });
  assert.equal(r.ok, false);
  assert.deepEqual(doc, JSON.parse(before));
  const ok = D.applyOp(doc, { type: 'batch', ops: [{ type: 'text', id: 'aaaa', text: 'one' }, { type: 'text', id: 'bbbb', text: 'two' }] });
  assert.ok(ok.ok);
  assert.ok(D.applyOp(doc, ok.inverse).ok);
  assert.deepEqual(doc, JSON.parse(before));
});

test('only whitelisted operations count as client operations', () => {
  assert.ok(D.isClientOp({ type: 'text', id: 'aaaa', text: 'x' }));
  assert.ok(D.isClientOp({ type: 'batch', ops: [{ type: 'move', id: 'aaaa', dx: 1, dy: 1 }] }));
  assert.equal(D.isClientOp({ type: 'restore', nodes: [] }), false);
  assert.equal(D.isClientOp({ type: 'batch', ops: [{ type: 'batch', ops: [] }] }), false);
  assert.equal(D.isClientOp({ type: 'constructor' }), false);
});

test('map size is capped', () => {
  const doc = D.newDoc('Root');
  let i = 0;
  for (; i < D.MAX_NODES - 1; i++) assert.ok(D.applyOp(doc, { type: 'add', id: 'n' + String(i).padStart(6, '0'), parent: doc.rootId, text: '', x: 0, y: 0 }).ok);
  assert.equal(D.applyOp(doc, { type: 'add', id: 'overflow1', parent: doc.rootId, text: '', x: 0, y: 0 }).ok, false);
});

test('tidy layout never overlaps nodes and keeps the root in place', () => {
  const doc = D.newDoc('Central idea');
  const r = doc.rootId;
  let n = 0;
  const add = (parent, text) => {
    const id = 'id' + String(n++).padStart(4, '0');
    assert.ok(D.applyOp(doc, { type: 'add', id, parent, text, x: 0, y: 0 }).ok);
    return id;
  };
  for (let i = 0; i < 7; i++) {
    const a = add(r, 'Branch number ' + i + ' with a fairly long label that wraps onto more lines');
    for (let j = 0; j < 4; j++) {
      const b = add(a, 'Child ' + j);
      for (let k = 0; k < 2; k++) add(b, 'Leaf ' + k);
    }
  }
  const pos = D.tidy(doc);
  assert.deepEqual(pos[r], [0, 0]);
  const boxes = Object.keys(doc.nodes).map((id) => {
    const s = D.sizeOf(doc, id);
    return { id, x: pos[id][0], y: pos[id][1], w: s.w, h: s.h };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${a.id} overlaps ${b.id}`);
    }
  }
  assert.ok(D.applyOp(doc, { type: 'layout', pos }).ok);
});

test('suggestChildPos puts a new child clear of existing siblings', () => {
  const doc = sample();
  const pos = D.tidy(doc);
  D.applyOp(doc, { type: 'layout', pos });
  const p = D.suggestChildPos(doc, 'aaaa');
  const s = D.nodeSize('', false);
  for (const sib of doc.nodes.aaaa.children) {
    const n = doc.nodes[sib];
    const z = D.sizeOf(doc, sib);
    const overlap = p.x < n.x + z.w && n.x < p.x + s.w && p.y < n.y + z.h && n.y < p.y + s.h;
    assert.equal(overlap, false);
  }
});

test('export then import round-trips structure, text and colours with new ids', () => {
  const doc = sample();
  D.applyOp(doc, { type: 'color', id: 'cccc', color: 'green' });
  const tree = D.toTree(doc, 'My map');
  const copy = D.fromTree(JSON.parse(JSON.stringify(tree)));
  assert.equal(D.count(copy), D.count(doc));
  assert.notEqual(copy.rootId, doc.rootId);
  assert.deepEqual(D.toTree(copy).root, tree.root);
  assert.ok(D.validDoc(copy));
});

test('import tidies maps that have no positions and rejects junk', () => {
  const doc = D.fromTree({ format: 'idea-map', root: { text: 'Root', children: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] } });
  const xs = new Set(Object.values(doc.nodes).map((n) => n.x));
  assert.ok(xs.size > 1);
  assert.throws(() => D.fromTree({ nope: 1 }));
  assert.throws(() => D.fromTree(null));
  assert.throws(() => D.fromTree({ format: 'idea-map', root: { text: 'r', children: 'x' } }));
  let deep = { text: 'leaf' };
  for (let i = 0; i < 100; i++) deep = { text: 'n', children: [deep] };
  assert.throws(() => D.fromTree({ format: 'idea-map', root: deep }), /deeply/);
});
