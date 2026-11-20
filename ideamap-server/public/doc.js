/*
 * Idea Map document engine. Shared by the server (authoritative) and the
 * browser (optimistic). A document is:
 *   { rootId, nodes: { [id]: { id, parent, text, x, y, color, children: [id] } } }
 * All changes go through applyOp(). applyOp validates first, then mutates, and
 * returns { ok, inverse } so the caller can build undo. On failure the document
 * is left untouched.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IdeaDoc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_NODES = 2000;
  const MAX_TEXT = 500;
  const MAX_COORD = 100000;
  const MAX_DEPTH = 60;
  const MAX_BATCH = 250;
  const MAX_LEGEND = 40; // characters in the name of a colour
  const COLORS = ['default', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'grey'];
  const ID_RE = /^[A-Za-z0-9_-]{4,24}$/;
  const CLIENT_OPS = ['add', 'text', 'move', 'reparent', 'delete', 'color', 'layout', 'legend', 'batch'];

  const HG = 70; // horizontal gap between levels
  const VG = 18; // vertical gap between siblings

  const webcrypto = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('crypto').webcrypto;

  function newId() {
    const bytes = new Uint8Array(9);
    webcrypto.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    const b64 = (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const isNum = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD;
  const fail = (error) => ({ ok: false, error });

  function cleanText(s) {
    return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\r\n?/g, '\n');
  }

  function newDoc(rootText) {
    const id = newId();
    return {
      rootId: id,
      legend: {},
      nodes: { [id]: { id, parent: null, text: cleanText(rootText || 'Central idea').slice(0, MAX_TEXT), x: 0, y: 0, color: 'default', children: [] } },
    };
  }

  function clone(doc) {
    return JSON.parse(JSON.stringify(doc));
  }

  function count(doc) {
    return Object.keys(doc.nodes).length;
  }

  function subtreeIds(doc, id) {
    const out = [];
    const stack = [id];
    while (stack.length) {
      const n = doc.nodes[stack.pop()];
      if (!n) continue;
      out.push(n.id);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    return out; // pre-order
  }

  function isDescendant(doc, id, ancestorId) {
    let cur = doc.nodes[id];
    let guard = 0;
    while (cur && guard++ < MAX_NODES + 5) {
      if (cur.id === ancestorId) return true;
      cur = cur.parent ? doc.nodes[cur.parent] : null;
    }
    return false;
  }

  function depthOf(doc, id) {
    let d = 0;
    let cur = doc.nodes[id];
    while (cur && cur.parent) {
      d++;
      cur = doc.nodes[cur.parent];
      if (d > MAX_DEPTH + 5) break;
    }
    return d;
  }

  function subtreeHeight(doc, id) {
    // levels below id (0 for a leaf)
    let best = 0;
    const stack = [[id, 0]];
    while (stack.length) {
      const [nid, d] = stack.pop();
      if (d > best) best = d;
      for (const c of doc.nodes[nid].children) stack.push([c, d + 1]);
    }
    return best;
  }

  /* ---------- sizing & layout (also used by the client to place nodes) ---------- */

  function nodeSize(text, isRoot) {
    // Generous on purpose: the box is border-box with 16px padding and a 2px border each side,
    // and a too-narrow estimate would break short words mid-way.
    const cw = isRoot ? 10 : 8.4;
    const padX = 40;
    const maxW = 280;
    const lines = String(text || '').split('\n');
    let longest = 1;
    for (const l of lines) if (l.length > longest) longest = l.length;
    const w = Math.min(maxW, Math.max(isRoot ? 124 : 76, Math.ceil(longest * cw) + padX));
    const inner = w - padX;
    let n = 0;
    for (const l of lines) n += Math.max(1, Math.ceil((l.length * cw) / inner));
    return { w, h: n * 20 + 24 };
  }

  function sizeOf(doc, id) {
    return nodeSize(doc.nodes[id].text, id === doc.rootId);
  }

  // Tidy layout: root stays put, branches alternate right/left, subtrees never overlap.
  function tidy(doc) {
    const nodes = doc.nodes;
    const rootNode = nodes[doc.rootId];
    const rs = sizeOf(doc, doc.rootId);
    const cy = rootNode.y + rs.h / 2;
    const pos = {};
    pos[rootNode.id] = [rootNode.x, rootNode.y];
    const H = {};
    const calc = (id) => {
      const kids = nodes[id].children;
      let sum = 0;
      for (const k of kids) {
        calc(k);
        sum += H[k];
      }
      sum += Math.max(0, kids.length - 1) * VG;
      H[id] = Math.max(sizeOf(doc, id).h, sum);
    };
    rootNode.children.forEach(calc);
    const place = (id, dir, edgeX, centerY) => {
      const s = sizeOf(doc, id);
      const x = dir > 0 ? edgeX + HG : edgeX - HG - s.w;
      pos[id] = [Math.round(x), Math.round(centerY - s.h / 2)];
      const kids = nodes[id].children;
      if (!kids.length) return;
      const total = kids.reduce((a, k) => a + H[k], 0) + (kids.length - 1) * VG;
      let y = centerY - total / 2;
      const near = dir > 0 ? x + s.w : x;
      for (const k of kids) {
        place(k, dir, near, y + H[k] / 2);
        y += H[k] + VG;
      }
    };
    const stack = (list, dir) => {
      if (!list.length) return;
      const total = list.reduce((a, k) => a + H[k], 0) + (list.length - 1) * VG;
      let y = cy - total / 2;
      const edge = dir > 0 ? rootNode.x + rs.w : rootNode.x;
      for (const k of list) {
        place(k, dir, edge, y + H[k] / 2);
        y += H[k] + VG;
      }
    };
    const right = [];
    const left = [];
    rootNode.children.forEach((c, i) => (i % 2 === 0 ? right : left).push(c));
    stack(right, 1);
    stack(left, -1);
    return pos;
  }

  function sideOf(doc, id) {
    // +1 right of root, -1 left of root
    const r = doc.nodes[doc.rootId];
    const rc = r.x + sizeOf(doc, doc.rootId).w / 2;
    const n = doc.nodes[id];
    return n.x + sizeOf(doc, id).w / 2 >= rc ? 1 : -1;
  }

  // Where to drop a brand-new child so it does not land on top of its siblings.
  // `text` is the idea about to be placed: a left-side idea is positioned by its left edge, so its real width matters.
  function suggestChildPos(doc, parentId, dirOverride, text) {
    const p = doc.nodes[parentId];
    const ps = sizeOf(doc, parentId);
    const w = nodeSize(text || '', false).w;
    let dir;
    if (dirOverride === 1 || dirOverride === -1) dir = dirOverride;
    else if (parentId === doc.rootId) dir = p.children.length % 2 === 0 ? 1 : -1;
    else dir = sideOf(doc, parentId);
    let y = p.y;
    let bottom = null;
    for (const c of p.children) {
      if (parentId === doc.rootId && sideOf(doc, c) !== dir) continue;
      for (const id of subtreeIds(doc, c)) {
        const n = doc.nodes[id];
        const b = n.y + sizeOf(doc, id).h;
        if (bottom === null || b > bottom) bottom = b;
      }
    }
    if (bottom !== null) y = bottom + VG;
    const x = dir > 0 ? p.x + ps.w + HG : p.x - HG - w;
    return { x: Math.round(x), y: Math.round(y) };
  }

  /* ---------- operations ---------- */

  function isClientOp(op, depth) {
    if (!op || typeof op !== 'object' || !CLIENT_OPS.includes(op.type)) return false;
    if (op.type === 'batch') {
      if (depth || !Array.isArray(op.ops)) return false;
      return op.ops.every((o) => isClientOp(o, 1));
    }
    return true;
  }

  function translate(doc, id, dx, dy) {
    for (const nid of subtreeIds(doc, id)) {
      doc.nodes[nid].x += dx;
      doc.nodes[nid].y += dy;
    }
  }

  const handlers = {
    add(doc, op) {
      if (!ID_RE.test(op.id || '')) return fail('Bad node id');
      if (doc.nodes[op.id]) return fail('Node already exists');
      const parent = doc.nodes[op.parent];
      if (!parent) return fail('Parent not found');
      if (count(doc) >= MAX_NODES) return fail('This map is full (' + MAX_NODES + ' ideas)');
      if (depthOf(doc, parent.id) + 1 > MAX_DEPTH) return fail('Too deeply nested');
      const text = op.text === undefined ? '' : op.text;
      if (typeof text !== 'string' || text.length > MAX_TEXT) return fail('Text too long');
      if (!isNum(op.x) || !isNum(op.y)) return fail('Bad position');
      const color = op.color === undefined ? 'default' : op.color;
      if (!COLORS.includes(color)) return fail('Bad colour');
      let index = Number.isInteger(op.index) ? op.index : parent.children.length;
      index = Math.max(0, Math.min(parent.children.length, index));
      doc.nodes[op.id] = { id: op.id, parent: parent.id, text: cleanText(text), x: op.x, y: op.y, color, children: [] };
      parent.children.splice(index, 0, op.id);
      return { ok: true, inverse: { type: 'delete', id: op.id } };
    },

    text(doc, op) {
      const n = doc.nodes[op.id];
      if (!n) return fail('Node not found');
      if (typeof op.text !== 'string' || op.text.length > MAX_TEXT) return fail('Text too long');
      const old = n.text;
      n.text = cleanText(op.text);
      return { ok: true, inverse: { type: 'text', id: n.id, text: old } };
    },

    move(doc, op) {
      const n = doc.nodes[op.id];
      if (!n) return fail('Node not found');
      if (typeof op.dx !== 'number' || typeof op.dy !== 'number' || !Number.isFinite(op.dx) || !Number.isFinite(op.dy)) return fail('Bad offset');
      const ids = subtreeIds(doc, n.id);
      for (const id of ids) {
        const m = doc.nodes[id];
        if (Math.abs(m.x + op.dx) > MAX_COORD || Math.abs(m.y + op.dy) > MAX_COORD) return fail('Out of bounds');
      }
      translate(doc, n.id, op.dx, op.dy);
      return { ok: true, inverse: { type: 'move', id: n.id, dx: -op.dx, dy: -op.dy } };
    },

    color(doc, op) {
      const n = doc.nodes[op.id];
      if (!n) return fail('Node not found');
      if (!COLORS.includes(op.color)) return fail('Bad colour');
      const old = n.color;
      n.color = op.color;
      return { ok: true, inverse: { type: 'color', id: n.id, color: old } };
    },

    reparent(doc, op) {
      const n = doc.nodes[op.id];
      const np = doc.nodes[op.parent];
      if (!n || !np) return fail('Node not found');
      if (n.id === doc.rootId) return fail('The central idea cannot be moved under another idea');
      if (isDescendant(doc, np.id, n.id)) return fail('An idea cannot move under itself');
      if (depthOf(doc, np.id) + 1 + subtreeHeight(doc, n.id) > MAX_DEPTH) return fail('Too deeply nested');
      const oldParent = doc.nodes[n.parent];
      const oldIndex = oldParent.children.indexOf(n.id);
      oldParent.children.splice(oldIndex, 1);
      let index = Number.isInteger(op.index) ? op.index : np.children.length;
      index = Math.max(0, Math.min(np.children.length, index));
      np.children.splice(index, 0, n.id);
      n.parent = np.id;
      return { ok: true, inverse: { type: 'reparent', id: n.id, parent: oldParent.id, index: oldIndex } };
    },

    delete(doc, op) {
      const n = doc.nodes[op.id];
      if (!n) return fail('Node not found');
      if (n.id === doc.rootId) return fail('The central idea cannot be deleted');
      const ids = subtreeIds(doc, n.id);
      const parent = doc.nodes[n.parent];
      const index = parent.children.indexOf(n.id);
      const snapshot = ids.map((id) => JSON.parse(JSON.stringify(doc.nodes[id])));
      parent.children.splice(index, 1);
      for (const id of ids) delete doc.nodes[id];
      return { ok: true, inverse: { type: 'restore', nodes: snapshot, parent: parent.id, index } };
    },

    // Internal: brings back a deleted subtree (used by undo).
    restore(doc, op) {
      const parent = doc.nodes[op.parent];
      if (!parent) return fail('Parent not found');
      if (!Array.isArray(op.nodes) || op.nodes.length < 1) return fail('Nothing to restore');
      if (count(doc) + op.nodes.length > MAX_NODES) return fail('This map is full');
      const seen = new Set();
      for (const n of op.nodes) {
        if (!n || !ID_RE.test(n.id || '') || doc.nodes[n.id] || seen.has(n.id)) return fail('Cannot restore');
        if (typeof n.text !== 'string' || n.text.length > MAX_TEXT || !isNum(n.x) || !isNum(n.y) || !COLORS.includes(n.color) || !Array.isArray(n.children)) return fail('Cannot restore');
        seen.add(n.id);
      }
      const top = op.nodes[0];
      for (const n of op.nodes) {
        for (const c of n.children) if (!seen.has(c)) return fail('Cannot restore');
        if (n !== top && !seen.has(n.parent)) return fail('Cannot restore');
      }
      for (const n of op.nodes) {
        doc.nodes[n.id] = { id: n.id, parent: n === top ? parent.id : n.parent, text: cleanText(n.text), x: n.x, y: n.y, color: n.color, children: n.children.slice() };
      }
      const index = Math.max(0, Math.min(parent.children.length, Number.isInteger(op.index) ? op.index : parent.children.length));
      parent.children.splice(index, 0, top.id);
      return { ok: true, inverse: { type: 'delete', id: top.id } };
    },

    // The colour key: what each colour means in this map. An empty label clears the name.
    legend(doc, op) {
      if (!COLORS.includes(op.color)) return fail('Bad colour');
      if (typeof op.label !== 'string') return fail('Bad name');
      const label = cleanText(op.label).replace(/\s+/g, ' ').trim();
      if (label.length > MAX_LEGEND) return fail('Colour names can be ' + MAX_LEGEND + ' characters at most');
      if (!doc.legend || typeof doc.legend !== 'object') doc.legend = {};
      const old = Object.prototype.hasOwnProperty.call(doc.legend, op.color) ? doc.legend[op.color] : '';
      if (label) doc.legend[op.color] = label;
      else delete doc.legend[op.color];
      return { ok: true, inverse: { type: 'legend', color: op.color, label: old } };
    },

    layout(doc, op) {
      if (!op.pos || typeof op.pos !== 'object') return fail('Bad layout');
      const ids = Object.keys(op.pos);
      if (ids.length > MAX_NODES) return fail('Bad layout');
      for (const id of ids) {
        const p = op.pos[id];
        if (!doc.nodes[id] || !Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) return fail('Bad layout');
      }
      const old = {};
      for (const id of ids) {
        old[id] = [doc.nodes[id].x, doc.nodes[id].y];
        doc.nodes[id].x = op.pos[id][0];
        doc.nodes[id].y = op.pos[id][1];
      }
      return { ok: true, inverse: { type: 'layout', pos: old } };
    },
  };

  function applyOp(doc, op) {
    if (!op || typeof op !== 'object') return fail('Bad operation');
    if (op.type === 'batch') {
      if (!Array.isArray(op.ops) || op.ops.length < 1 || op.ops.length > MAX_BATCH) return fail('Bad batch');
      const inverses = [];
      for (const o of op.ops) {
        if (!o || o.type === 'batch') {
          rollback(doc, inverses);
          return fail('Bad batch');
        }
        const r = applyOp(doc, o);
        if (!r.ok) {
          rollback(doc, inverses);
          return r;
        }
        inverses.push(r.inverse);
      }
      return { ok: true, inverse: { type: 'batch', ops: inverses.reverse() } };
    }
    const h = Object.prototype.hasOwnProperty.call(handlers, op.type) ? handlers[op.type] : null;
    if (!h) return fail('Unknown operation');
    return h(doc, op);
  }

  function rollback(doc, inverses) {
    for (let i = inverses.length - 1; i >= 0; i--) applyOp(doc, inverses[i]);
  }


  /* ---------- outline copy/paste, duplicate, search (used by the editor) ---------- */

  // A branch as indented text ("- idea" lines). Round-trips through parseOutline.
  function toOutline(doc, id) {
    const lines = [];
    const walk = (nid, depth) => {
      const n = doc.nodes[nid];
      lines.push('  '.repeat(depth) + '- ' + n.text.replace(/\s*\n\s*/g, ' ').trim());
      for (const c of n.children) walk(c, depth + 1);
    };
    if (doc.nodes[id]) walk(id, 0);
    return lines.join('\n');
  }

  const OUTLINE_LINE_CAP = 240;
  const OUTLINE_TEXT_CAP = 200;

  // Plain text -> [{ depth, text }]. Understands indentation (spaces or tabs, any consistent width),
  // bullets (- * • –), numbering (1. 2)) and markdown headings. Blank lines are ignored.
  function parseOutline(text) {
    const items = [];
    const stack = [];
    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      if (!raw.trim()) continue;
      const expanded = raw.replace(/\t/g, '    ');
      const indent = expanded.match(/^ */)[0].length;
      const body = expanded.trim().replace(/^#{1,6}\s+/, '').replace(/^([-*•–—]|\d+[.)])(\s+|$)/, '').replace(/\s+/g, ' ').trim();
      if (!body) continue;
      while (stack.length && stack[stack.length - 1] > indent) stack.pop();
      if (!stack.length || stack[stack.length - 1] < indent) stack.push(indent);
      items.push({ depth: stack.length - 1, text: cleanText(body).slice(0, OUTLINE_TEXT_CAP) });
    }
    return items;
  }

  // Ideas pasted from text, as ONE batch of add operations under parentId.
  function opsFromOutline(doc, parentId, text) {
    if (!doc.nodes[parentId]) return { error: 'Select an idea to paste under' };
    const all = parseOutline(text);
    if (!all.length) return { error: 'There is no text to turn into ideas' };
    const items = all.slice(0, OUTLINE_LINE_CAP);
    if (count(doc) + items.length > MAX_NODES) return { error: 'This map does not have room for that many ideas' };
    const work = clone(doc);
    const parents = [parentId];
    const ops = [];
    const base = items[0].depth;
    for (const it of items) {
      const depth = Math.max(0, Math.min(it.depth - base, parents.length - 1));
      const parent = parents[depth];
      const pos = suggestChildPos(work, parent, undefined, it.text);
      const op = { type: 'add', id: newId(), parent, text: it.text, x: pos.x, y: pos.y };
      const r = applyOp(work, op);
      if (!r.ok) return { error: r.error };
      ops.push(op);
      parents.length = depth + 1;
      parents.push(op.id);
    }
    return { op: { type: 'batch', ops }, count: ops.length, truncated: all.length > items.length };
  }

  // A copy of a branch placed just below the original, as ONE batch of add operations.
  function duplicateBranch(doc, id) {
    const src = doc.nodes[id];
    if (!src) return { error: 'Idea not found' };
    if (!src.parent) return { error: 'The central idea cannot be duplicated' };
    const ids = subtreeIds(doc, id);
    if (ids.length > MAX_BATCH) return { error: 'That branch is too large to duplicate (' + MAX_BATCH + ' ideas at most)' };
    if (count(doc) + ids.length > MAX_NODES) return { error: 'This map does not have room for a copy' };
    let top = Infinity;
    let bottom = -Infinity;
    for (const nid of ids) {
      const n = doc.nodes[nid];
      top = Math.min(top, n.y);
      bottom = Math.max(bottom, n.y + sizeOf(doc, nid).h);
    }
    const dy = Math.round(bottom - top + 36);
    const map = new Map(ids.map((nid) => [nid, newId()]));
    const parent = doc.nodes[src.parent];
    const ops = ids.map((nid) => {
      const n = doc.nodes[nid];
      const op = { type: 'add', id: map.get(nid), parent: nid === id ? parent.id : map.get(n.parent), text: nid === id ? (n.text + ' (copy)').slice(0, MAX_TEXT) : n.text, x: n.x, y: n.y + dy, color: n.color };
      if (nid === id) op.index = parent.children.indexOf(id) + 1;
      return op;
    });
    const batch = { type: 'batch', ops };
    if (!applyOp(clone(doc), batch).ok) return { error: 'Could not duplicate that branch' };
    return { op: batch, count: ops.length, newRoot: map.get(id) };
  }

  // Ids of ideas whose text contains the query (case-insensitive), in reading order.
  function search(doc, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return subtreeIds(doc, doc.rootId).filter((id) => doc.nodes[id].text.toLowerCase().includes(q));
  }

  /* ---------- import / export ---------- */

  function toTree(doc, title) {
    const walk = (id) => {
      const n = doc.nodes[id];
      return { text: n.text, color: n.color, x: n.x, y: n.y, children: n.children.map(walk) };
    };
    const legend = {};
    for (const c of COLORS) if (doc.legend && typeof doc.legend[c] === 'string' && doc.legend[c]) legend[c] = doc.legend[c];
    return { format: 'idea-map', version: 1, title: title || '', exportedAt: new Date().toISOString(), legend, root: walk(doc.rootId) };
  }

  // Builds a fresh document (new ids) from an exported tree. Throws Error on bad input.
  function fromTree(input) {
    if (!input || typeof input !== 'object' || input.format !== 'idea-map' || !input.root || typeof input.root !== 'object') {
      throw new Error('This is not an Idea Map export');
    }
    const nodes = {};
    let total = 0;
    let hasPos = true;
    const build = (t, parent, depth) => {
      if (!t || typeof t !== 'object') throw new Error('Bad node in file');
      if (depth > MAX_DEPTH) throw new Error('File is nested too deeply');
      if (++total > MAX_NODES) throw new Error('File has more than ' + MAX_NODES + ' ideas');
      const id = newId();
      const text = typeof t.text === 'string' ? cleanText(t.text).slice(0, MAX_TEXT) : '';
      const color = COLORS.includes(t.color) ? t.color : 'default';
      if (!isNum(t.x) || !isNum(t.y)) hasPos = false;
      nodes[id] = { id, parent, text, x: isNum(t.x) ? t.x : 0, y: isNum(t.y) ? t.y : 0, color, children: [] };
      if (t.children !== undefined && !Array.isArray(t.children)) throw new Error('Bad children in file');
      for (const c of t.children || []) nodes[id].children.push(build(c, id, depth + 1));
      return id;
    };
    const rootId = build(input.root, null, 0);
    const legend = {};
    if (input.legend && typeof input.legend === 'object' && !Array.isArray(input.legend)) {
      for (const c of COLORS) {
        if (typeof input.legend[c] !== 'string') continue;
        const l = cleanText(input.legend[c]).replace(/\s+/g, ' ').trim().slice(0, MAX_LEGEND);
        if (l) legend[c] = l;
      }
    }
    const doc = { rootId, legend, nodes };
    if (!hasPos) {
      nodes[rootId].x = 0;
      nodes[rootId].y = 0;
      const pos = tidy(doc);
      for (const id of Object.keys(pos)) {
        nodes[id].x = pos[id][0];
        nodes[id].y = pos[id][1];
      }
    }
    return doc;
  }

  // Structural sanity check for a doc loaded from storage.
  function validDoc(doc) {
    if (!doc || typeof doc !== 'object' || !doc.nodes || !doc.nodes[doc.rootId]) return false;
    for (const id of Object.keys(doc.nodes)) {
      const n = doc.nodes[id];
      if (!n || n.id !== id || !Array.isArray(n.children)) return false;
      for (const c of n.children) if (!doc.nodes[c] || doc.nodes[c].parent !== id) return false;
    }
    return true;
  }

  function searchText(doc, title) {
    const parts = [title];
    if (doc.legend) for (const c of COLORS) if (doc.legend[c]) parts.push(doc.legend[c]);
    for (const id of Object.keys(doc.nodes)) parts.push(doc.nodes[id].text);
    return parts.join('\n').toLowerCase().slice(0, 200000);
  }

  return {
    MAX_NODES, MAX_TEXT, MAX_DEPTH, MAX_LEGEND, COLORS, ID_RE,
    newId, newDoc, clone, count, cleanText,
    subtreeIds, isDescendant, depthOf,
    nodeSize, sizeOf, tidy, sideOf, suggestChildPos,
    isClientOp, applyOp,
    toTree, fromTree, validDoc, searchText,
    toOutline, parseOutline, opsFromOutline, duplicateBranch, search,
  };
});
