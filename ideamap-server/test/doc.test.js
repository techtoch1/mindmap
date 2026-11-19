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

function branchy() {
  const doc = D.newDoc('Root');
  const add = (id, parent, text, color) => assert.ok(D.applyOp(doc, { type: 'add', id, parent, text, x: 0, y: 0, ...(color ? { color } : {}) }).ok);
  add('aaaa', doc.rootId, 'Channels', 'blue');
  add('bbbb', 'aaaa', 'Email');
  add('cccc', 'aaaa', 'LinkedIn');
  add('dddd', 'cccc', 'Founder story', 'green');
  add('eeee', doc.rootId, 'Offer');
  D.applyOp(doc, { type: 'layout', pos: D.tidy(doc) });
  return doc;
}
const shape = (doc, id) => ({ text: doc.nodes[id].text, color: doc.nodes[id].color, kids: doc.nodes[id].children.map((c) => shape(doc, c)) });

test('outline: copy a branch as text and paste it back as the same structure', () => {
  const doc = branchy();
  const text = D.toOutline(doc, 'aaaa');
  assert.equal(text, '- Channels\n  - Email\n  - LinkedIn\n    - Founder story');
  const r = D.opsFromOutline(doc, 'eeee', text);
  assert.equal(r.count, 4);
  assert.ok(D.isClientOp(r.op));
  const pasted = D.clone(doc);
  const applied = D.applyOp(pasted, r.op);
  assert.ok(applied.ok, applied.error);
  const copy = shape(pasted, pasted.nodes.eeee.children[0]);
  assert.deepEqual(copy.kids.map((k) => k.text), ['Email', 'LinkedIn']);
  assert.equal(copy.text, 'Channels');
  assert.equal(copy.kids[1].kids[0].text, 'Founder story');
  assert.ok(D.validDoc(pasted));
  assert.ok(D.applyOp(pasted, applied.inverse).ok);
  assert.deepEqual(pasted, doc, 'one undo removes everything pasted');
});

test('outline: understands bullets, numbering, tabs, headings, odd indents and blank lines', () => {
  const t = (s) => D.parseOutline(s).map((i) => i.depth + ':' + i.text);
  assert.deepEqual(t('- a\n- b\n  - c\n  - d\n    - e\n- f'), ['0:a', '0:b', '1:c', '1:d', '2:e', '0:f']);
  assert.deepEqual(t('1. one\n2) two\n\n   • nested\n\t\t* deeper'), ['0:one', '0:two', '1:nested', '2:deeper']);
  assert.deepEqual(t('# Title\n## Sub\n- item'), ['0:Title', '0:Sub', '0:item']);
  assert.deepEqual(t('plain\n   indented by three\n      indented by six\nback'), ['0:plain', '1:indented by three', '2:indented by six', '0:back']);
  assert.deepEqual(t('a\r\n  b\r\n'), ['0:a', '1:b']);
  assert.deepEqual(t('   \n\n'), []);
  assert.deepEqual(t('- \n-   \n- real'), ['0:real']);
  assert.equal(D.parseOutline('x'.repeat(500))[0].text.length, 200);
  // a deep indent jump never skips a level
  assert.deepEqual(t('a\n          far'), ['0:a', '1:far']);
});

test('outline: pasting under a chosen idea, a single line, markup stays text, limits hold', () => {
  const doc = branchy();
  assert.equal(D.opsFromOutline(doc, 'nope', 'x').error, 'Select an idea to paste under');
  assert.match(D.opsFromOutline(doc, 'aaaa', '  \n ').error, /no text/);
  const one = D.opsFromOutline(doc, 'bbbb', 'TikTok duets');
  assert.equal(one.count, 1);
  const html = D.opsFromOutline(doc, 'bbbb', '<img src=x onerror=alert(1)>');
  assert.equal(html.op.ops[0].text, '<img src=x onerror=alert(1)>', 'kept as plain text; the UI only ever uses textContent');
  const many = D.opsFromOutline(doc, 'aaaa', Array.from({ length: 400 }, (_, i) => '- idea ' + i).join('\n'));
  assert.equal(many.count, 240);
  assert.equal(many.truncated, true);
  const full = D.newDoc('Full');
  for (let i = 0; i < D.MAX_NODES - 1; i++) D.applyOp(full, { type: 'add', id: 'n' + String(i).padStart(6, '0'), parent: full.rootId, text: '', x: 0, y: 0 });
  assert.match(D.opsFromOutline(full, full.rootId, '- one more').error, /room/);
});

test('outline: pasted ideas do not land on top of each other', () => {
  const doc = branchy();
  const r = D.opsFromOutline(doc, 'aaaa', '- one\n- two\n- three\n  - three a\n  - three b\n- four');
  const next = D.clone(doc);
  D.applyOp(next, r.op);
  const ids = D.subtreeIds(next, 'aaaa');
  const boxes = ids.map((id) => ({ id, x: next.nodes[id].x, y: next.nodes[id].y, ...D.sizeOf(next, id) }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.equal(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, false, `${a.id} overlaps ${b.id}`);
  }
});

test('duplicate branch: same shape and colours, placed below, right after the original, one undo', () => {
  const doc = branchy();
  const r = D.duplicateBranch(doc, 'aaaa');
  assert.equal(r.count, 4);
  assert.ok(D.isClientOp(r.op));
  const next = D.clone(doc);
  const applied = D.applyOp(next, r.op);
  assert.ok(applied.ok, applied.error);
  const kids = next.nodes[next.rootId].children;
  assert.deepEqual(kids.map((k) => next.nodes[k].text), ['Channels', 'Channels (copy)', 'Offer'], 'copy sits right after the original');
  const copy = next.nodes[r.newRoot];
  assert.equal(copy.color, 'blue');
  assert.deepEqual(shape(next, r.newRoot).kids.map((k) => k.text), ['Email', 'LinkedIn']);
  assert.equal(shape(next, r.newRoot).kids[1].kids[0].color, 'green');
  assert.ok(copy.y > next.nodes.aaaa.y, 'placed below the original');
  const ids = new Set(D.subtreeIds(doc, 'aaaa'));
  for (const id of D.subtreeIds(next, r.newRoot)) assert.ok(!ids.has(id), 'every copied idea has a new id');
  assert.ok(D.applyOp(next, applied.inverse).ok);
  assert.deepEqual(next, doc);
  assert.match(D.duplicateBranch(doc, doc.rootId).error, /central idea/);
  assert.match(D.duplicateBranch(doc, 'nope').error, /not found/);
});

test('search finds ideas by text, case-insensitively, in reading order', () => {
  const doc = branchy();
  const texts = (q) => D.search(doc, q).map((id) => doc.nodes[id].text);
  assert.deepEqual(texts('l'), ['Channels', 'Email', 'LinkedIn', 'Founder story'.includes('l') ? 'Founder story' : null].filter(Boolean).concat([]).filter((x) => x.toLowerCase().includes('l')));
  assert.deepEqual(texts('LINKED'), ['LinkedIn']);
  assert.deepEqual(texts('  '), []);
  assert.deepEqual(texts('zzz'), []);
});

test('a long idea placed on the left side never lands on top of its parent', () => {
  const doc = branchy();
  D.applyOp(doc, { type: 'layout', pos: D.tidy(doc) });
  const left = Object.values(doc.nodes).find((n) => n.parent && D.sideOf(doc, n.id) < 0 && n.parent === doc.rootId);
  assert.ok(left, 'there is a branch on the left');
  const text = 'A rather long idea with plenty of words in it';
  const pos = D.suggestChildPos(doc, left.id, undefined, text);
  const w = D.nodeSize(text, false).w;
  assert.ok(pos.x + w <= left.x, `child right edge ${pos.x + w} must be left of parent edge ${left.x}`);
  // pasted outlines and duplicates follow the same rule
  const r = D.opsFromOutline(doc, left.id, '- ' + text + '\n  - Another fairly long sub idea here too');
  const next = D.clone(doc);
  assert.ok(D.applyOp(next, r.op).ok);
  const box = (id) => ({ x: next.nodes[id].x, y: next.nodes[id].y, ...D.sizeOf(next, id) });
  const parent = box(left.id);
  for (const id of D.subtreeIds(next, left.id).slice(1)) {
    const c = box(id);
    assert.equal(parent.x < c.x + c.w && c.x < parent.x + parent.w && parent.y < c.y + c.h && c.y < parent.y + parent.h, false, 'overlaps its ancestor');
  }
});
