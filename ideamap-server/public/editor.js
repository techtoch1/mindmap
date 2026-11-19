/*
 * Map editor. State model:
 *   base    = last document confirmed by the server (follows the server's version numbers exactly)
 *   pending = my edits the server has not echoed back yet
 *   view    = base + pending, which is what is drawn
 * Remote edits are applied to base and the view is rebuilt, so everyone converges on the server's order.
 */
(function () {
  'use strict';
  const D = window.IdeaDoc;
  const { h, icon, avatar, toast, modal, download } = window.IdeaUI;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const COLOR_NAMES = { default: 'Default', blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', purple: 'Purple', teal: 'Teal', grey: 'Grey' };

  function open(container, mapId, ctx) {
    /* ---------- state ---------- */
    let ws = null;
    let closed = false;
    let retry = 0;
    let connected = false;
    let base = null;
    let baseV = 0;
    let pending = [];
    let view = null;
    let me = null;
    let role = 'viewer';
    let title = '';
    let folded = new Set();
    let selected = null;
    let editing = null; // { id, fresh, orig, live, ta }
    let drag = null;
    let pan = null;
    let pinch = null;
    const pointers = new Map();
    let lastTap = { id: null, t: 0 };
    let lp = null; // long-press timer (touch)
    const flashIds = new Set();
    let search = { open: false, q: '', ids: [], i: -1 };
    let firstFit = true;
    let lastCursorSent = 0;
    let reconnectTimer = null;
    const peers = new Map(); // connId -> { c, userId, name, color, x, y, sel }
    const nodeEls = new Map();
    const nodeH = new Map();
    const cursorEls = new Map();
    let T = { tx: 40, ty: 40, k: 1 };

    const canEdit = () => role === 'admin' || role === 'editor';

    /* ---------- DOM ---------- */
    const status = h('span', { class: 'pill warn', role: 'status' }, h('span', { class: 'dot' }), h('span', { class: 'lbl' }, 'Connecting…'));
    const peersBox = h('div', { class: 'peers', 'aria-label': 'People in this map' });
    const titleHolder = h('div', { class: 'row' });
    const world = h('div', { class: 'world' });
    const edges = document.createElementNS(SVGNS, 'svg');
    edges.setAttribute('class', 'edges');
    const nodesLayer = h('div', { class: 'nodes' });
    const cursorsLayer = h('div', { class: 'cursors' });
    world.append(edges, nodesLayer, cursorsLayer);
    const zoomLabel = h('span', { class: 'lvl' }, '100%');
    const zoombar = h('div', { class: 'zoombar' },
      h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.25) }, icon('minus')),
      zoomLabel,
      h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.25) }, icon('plus')),
      h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Fit map to screen', 'aria-label': 'Fit map to screen', onclick: () => fit() }, icon('fit')),
      h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', onclick: () => showShortcuts() }, icon('help')));
    const hint = h('div', { class: 'hint' });
    const searchInput = h('input', { type: 'search', placeholder: 'Find an idea…', 'aria-label': 'Find an idea in this map', autocomplete: 'off' });
    const searchCount = h('span', { class: 'cnt', 'aria-live': 'polite' }, '');
    const searchBar = h('div', { class: 'mapsearch hidden', role: 'search' },
      searchInput, searchCount,
      h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Previous match', title: 'Previous (Shift+Enter)', onclick: () => gotoMatch(-1) }, '↑'),
      h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Next match', title: 'Next (Enter)', onclick: () => gotoMatch(1) }, '↓'),
      h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Close search', title: 'Close (Esc)', onclick: () => closeSearch() }, '✕'));
    const canvas = h('div', { class: 'canvas', tabindex: '0', role: 'application', 'aria-label': 'Mind map canvas. Use Tab to add an idea, Enter to add a sibling, F2 to edit, Delete to remove. Right-click for more actions.' }, world, zoombar, hint, searchBar);

    const btn = (label, ic, onclick, extra) => h('button', Object.assign({ class: 'btn sm', type: 'button', onclick, title: label }, extra || {}), icon(ic), h('span', {}, label));
    const bAddChild = btn('Add idea', 'child', () => selected && addChild(selected), { title: 'Add a child idea (Tab)' });
    const bAddSib = btn('Sibling', 'sibling', () => selected && addSibling(selected), { title: 'Add a sibling idea (Enter)' });
    const bDelete = btn('Delete', 'trash', () => selected && del(selected), { title: 'Delete the selected idea and its branch (Delete)' });
    const bFold = btn('Fold', 'fold', () => selected && toggleFold(selected), { title: 'Fold or unfold the selected branch (only for you)' });
    const bUndo = btn('Undo', 'undo', () => send({ t: 'undo' }), { title: 'Undo your last change (Ctrl+Z)' });
    const bRedo = btn('Redo', 'redo', () => send({ t: 'redo' }), { title: 'Redo (Ctrl+Shift+Z)' });
    const bTidy = btn('Tidy', 'tidy', () => tidy(), { title: 'Re-arrange the whole map neatly' });
    const bPng = btn('PNG', 'image', () => exportPng(), { title: 'Download the map as an image' });
    const bJson = btn('JSON', 'download', () => download(`/api/maps/${encodeURIComponent(mapId)}/export`, ''), { title: 'Download the map as a JSON file' });
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Colour of selected idea' },
      D.COLORS.map((c) => h('button', { class: 'sw c-' + c, type: 'button', title: COLOR_NAMES[c], 'aria-label': COLOR_NAMES[c], 'aria-pressed': 'false', dataset: { color: c }, onclick: () => selected && setColor(selected, c) })));
    const bFind = btn('Find', 'search', () => openSearch(), { title: 'Find an idea in this map (Ctrl+F)' });
    const bAsk = btn('Ask Claude', 'spark', () => ai.toggle(), { title: 'Brainstorm and customise this map with Claude' });
    const editTools = [bAsk, h('span', { class: 'sep' }), bAddChild, bAddSib, bDelete, h('span', { class: 'sep' }), swatches, h('span', { class: 'sep' }), bUndo, bRedo, bTidy, h('span', { class: 'sep' })];
    const toolbar = h('div', { class: 'ed-tools', role: 'toolbar', 'aria-label': 'Map tools' }, editTools, bFold, h('span', { class: 'sep' }), bFind, bPng, bJson);

    const bar = h('div', { class: 'ed-bar' },
      h('a', { class: 'btn ghost sm', href: '#/', title: 'Back to all maps' }, icon('back'), 'Maps'),
      titleHolder, h('span', { class: 'grow' }), peersBox, status);
    const ai = window.IdeaAiPanel.create({
      mapId, api: ctx.api, enabled: !!(ctx.ai && ctx.ai.enabled), isAdmin: !!ctx.isAdmin, autoAllowed: !!(ctx.ai && ctx.ai.autoApply),
      getSelected: () => selected,
      undo: () => send({ t: 'undo' }),
      apply: (op) => {
        if (!commit(op)) return false;
        flash(addedIds(op));
        fit(); // new branches can land off-screen
        if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) ai.close(); // the panel covers the map on phones
        return true;
      },
    });
    const root = h('div', { class: 'ed', id: 'main' }, bar, toolbar, h('div', { class: 'ed-body' }, canvas, ai.el));
    container.replaceChildren(root);

    /* ---------- networking ---------- */
    function send(msg) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    }

    function setStatus(kind) {
      const live = kind === 'live';
      status.className = 'pill' + (live ? '' : ' warn');
      status.querySelector('.lbl').textContent = live ? 'Live' : kind === 'connecting' ? 'Connecting…' : 'Reconnecting…';
    }

    function connect() {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${location.host}/ws?map=${encodeURIComponent(mapId)}`);
      ws = sock;
      sock.onmessage = (e) => {
        if (sock !== ws) return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        onMessage(m);
      };
      sock.onclose = (e) => {
        if (sock !== ws || closed) return;
        connected = false;
        peers.clear();
        renderPeers();
        renderCursors();
        if (e.code === 4404) {
          toast('This map was deleted.', { error: true });
          return ctx.navigate('#/');
        }
        if (e.code === 4401) return ctx.onSignedOut();
        setStatus('reconnecting');
        updateToolbar();
        const delay = Math.min(10000, 400 * Math.pow(2, retry++));
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    function resync() {
      if (ws) ws.close();
    }

    function onMessage(m) {
      switch (m.t) {
        case 'hello':
          me = m.you;
          role = m.you.role;
          title = m.map.title;
          base = m.doc;
          baseV = m.v;
          pending = [];
          folded = new Set(m.folds || []);
          peers.clear();
          for (const p of m.peers) peers.set(p.c, Object.assign({ sel: [] }, p));
          connected = true;
          retry = 0;
          setStatus('live');
          renderTitle();
          rebuildView();
          if (firstFit) {
            firstFit = false;
            fit();
          }
          renderPeers();
          break;
        case 'op': {
          if (m.v !== baseV + 1) return resync();
          const r = D.applyOp(base, m.op);
          if (!r.ok) return resync();
          baseV = m.v;
          if (m.cid) {
            const i = pending.findIndex((p) => p.cid === m.cid);
            if (i >= 0) pending.splice(i, 1);
          }
          rebuildView();
          break;
        }
        case 'reject': {
          const i = pending.findIndex((p) => p.cid === m.cid);
          if (i >= 0) pending.splice(i, 1);
          toast(m.error || 'That change was not accepted', { error: true });
          rebuildView();
          break;
        }
        case 'notice':
          toast(m.message);
          break;
        case 'title':
          title = m.title;
          renderTitle();
          break;
        case 'join':
          peers.set(m.peer.c, Object.assign({ sel: [] }, m.peer));
          renderPeers();
          break;
        case 'leave':
          peers.delete(m.c);
          renderPeers();
          renderCursors();
          renderAll();
          break;
        case 'cursor': {
          const p = peers.get(m.c);
          if (p) {
            p.x = m.x;
            p.y = m.y;
            renderCursors();
          }
          break;
        }
        case 'select': {
          const p = peers.get(m.c);
          if (p) {
            p.sel = m.ids;
            renderAll();
          }
          break;
        }
        default:
      }
    }

    function rebuildView() {
      view = D.clone(base);
      for (const p of pending) {
        const r = D.applyOp(view, p.op);
        if (!r.ok) p.dead = true;
      }
      pending = pending.filter((p) => !p.dead);
      renderAll();
    }

    // Apply an edit locally right away and send it. Returns true if accepted locally.
    function commit(op) {
      if (!canEdit()) {
        toast('You have view-only access to this map.');
        return false;
      }
      if (!connected) {
        toast('Reconnecting… edits are paused for a moment.');
        return false;
      }
      const r = D.applyOp(view, op);
      if (!r.ok) {
        toast(r.error, { error: true });
        return false;
      }
      const cid = D.newId();
      pending.push({ cid, op });
      send({ t: 'op', cid, op });
      renderAll();
      return true;
    }

    /* ---------- actions ---------- */
    function setSelected(id) {
      if (selected === id) return;
      selected = id;
      send({ t: 'select', ids: id ? [id] : [] });
      renderAll();
    }

    function saveFolds() {
      send({ t: 'fold', ids: Array.from(folded) });
    }

    function addChild(parentId, dir) {
      if (!view.nodes[parentId]) return;
      const pos = D.suggestChildPos(view, parentId, dir);
      const id = D.newId();
      if (commit({ type: 'add', id, parent: parentId, text: '', x: pos.x, y: pos.y })) {
        if (folded.delete(parentId)) saveFolds();
        setSelected(id);
        startEdit(id, true);
      }
    }

    function addSibling(id) {
      const n = view.nodes[id];
      if (!n) return;
      if (!n.parent) return addChild(id);
      const parent = view.nodes[n.parent];
      const dir = parent.id === view.rootId ? D.sideOf(view, id) : undefined;
      const pos = D.suggestChildPos(view, parent.id, dir);
      const nid = D.newId();
      if (commit({ type: 'add', id: nid, parent: parent.id, index: parent.children.indexOf(id) + 1, text: '', x: pos.x, y: pos.y })) {
        setSelected(nid);
        startEdit(nid, true);
      }
    }

    function del(id) {
      const n = view.nodes[id];
      if (!n) return;
      if (!n.parent) return toast('The central idea cannot be deleted.');
      const count = D.subtreeIds(view, id).length;
      if (commit({ type: 'delete', id })) {
        setSelected(n.parent);
        toast(count > 1 ? `Deleted ${count} ideas. Press Ctrl+Z to undo.` : 'Deleted. Press Ctrl+Z to undo.');
      }
    }

    function setColor(id, color) {
      if (view.nodes[id] && view.nodes[id].color !== color) commit({ type: 'color', id, color });
    }

    function toggleFold(id) {
      const n = view.nodes[id];
      if (!n || !n.children.length || id === view.rootId) return;
      if (!folded.delete(id)) folded.add(id);
      saveFolds();
      renderAll();
    }

    function tidy() {
      if (!canEdit()) return toast('You have view-only access to this map.');
      const pos = D.tidy(view);
      const changed = {};
      let n = 0;
      for (const id of Object.keys(pos)) {
        const node = view.nodes[id];
        if (node.x !== pos[id][0] || node.y !== pos[id][1]) {
          changed[id] = pos[id];
          n++;
        }
      }
      if (!n) return toast('Already tidy.');
      if (commit({ type: 'layout', pos: changed })) fit();
    }

    /* ---------- editing text ---------- */
    function startEdit(id, fresh) {
      if (!canEdit() || !view.nodes[id]) return;
      if (editing) finishEdit(true);
      const orig = view.nodes[id].text;
      const ta = h('textarea', { rows: '1', maxlength: String(D.MAX_TEXT), 'aria-label': 'Idea text', spellcheck: 'true' });
      ta.value = orig;
      editing = { id, fresh: !!fresh, orig, live: orig, ta };
      ta.addEventListener('input', () => {
        editing.live = ta.value;
        renderAll();
        autosize(ta);
      });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finishEdit(false);
          canvas.focus({ preventScroll: true });
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          finishEdit(true);
          canvas.focus({ preventScroll: true });
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const cur = editing.id;
          finishEdit(true);
          if (view.nodes[cur]) addChild(cur);
        }
        e.stopPropagation();
      });
      ta.addEventListener('blur', () => {
        if (editing && editing.ta === ta) finishEdit(true);
      });
      renderAll();
      ta.focus();
      ta.select();
      autosize(ta);
    }

    function autosize(ta) {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }

    function finishEdit(save) {
      if (!editing) return;
      const { id, fresh, orig, ta } = editing;
      const val = ta.value.replace(/\s+$/, '');
      editing = null;
      ta.remove();
      const exists = !!(view && view.nodes[id]);
      if (exists) {
        if (save && val !== orig) {
          // a left-side idea keeps its right edge when its wording gets wider or narrower (one undo step)
          const dw = D.nodeSize(orig, false).w - D.nodeSize(val, false).w;
          const t = { type: 'text', id, text: val };
          if (dw !== 0 && id !== view.rootId && D.sideOf(view, id) < 0) commit({ type: 'batch', ops: [t, { type: 'move', id, dx: dw, dy: 0 }] });
          else commit(t);
        }
        if (fresh && (!save || val === '') && !view.nodes[id].children.length) commit({ type: 'delete', id });
      }
      renderAll();
    }

    /* ---------- rendering ---------- */
    function applyTransform() {
      world.style.transform = `translate(${T.tx}px, ${T.ty}px) scale(${T.k})`;
      zoomLabel.textContent = Math.round(T.k * 100) + '%';
      renderCursors();
    }

    function toWorld(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return { x: (clientX - r.left - T.tx) / T.k, y: (clientY - r.top - T.ty) / T.k };
    }

    function zoomAt(factor, cx, cy) {
      const k = Math.max(0.15, Math.min(2.5, T.k * factor));
      const f = k / T.k;
      T.tx = cx - (cx - T.tx) * f;
      T.ty = cy - (cy - T.ty) * f;
      T.k = k;
      applyTransform();
    }

    function zoomBy(f) {
      const r = canvas.getBoundingClientRect();
      zoomAt(f, r.width / 2, r.height / 2);
    }

    function visibleIds() {
      const out = [];
      const walk = (id) => {
        out.push(id);
        if (!folded.has(id)) for (const c of view.nodes[id].children) walk(c);
      };
      walk(view.rootId);
      return out;
    }

    function bounds(ids) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of ids) {
        const n = view.nodes[id];
        const s = D.sizeOf(view, id);
        const hh = nodeH.get(id) || s.h;
        x0 = Math.min(x0, n.x);
        y0 = Math.min(y0, n.y);
        x1 = Math.max(x1, n.x + s.w);
        y1 = Math.max(y1, n.y + hh);
      }
      return { x0, y0, x1, y1 };
    }

    function fit() {
      if (!view) return;
      const b = bounds(visibleIds());
      const r = canvas.getBoundingClientRect();
      const w = b.x1 - b.x0;
      const hh = b.y1 - b.y0;
      const k = Math.max(0.15, Math.min(1.2, (r.width - 100) / w, (r.height - 100) / hh));
      const minK = r.width < 600 ? 0.5 : 0.15; // on a phone, fitting everything would make ideas too small to read or tap
      if (k < minK) {
        const rn = view.nodes[view.rootId];
        const rs = D.sizeOf(view, view.rootId);
        T.k = minK;
        T.tx = r.width / 2 - (rn.x + rs.w / 2) * minK;
        T.ty = r.height / 2 - (rn.y + rs.h / 2) * minK;
      } else {
        T.k = k;
        T.tx = (r.width - w * k) / 2 - b.x0 * k;
        T.ty = (r.height - hh * k) / 2 - b.y0 * k;
      }
      applyTransform();
    }

    function makeNodeEl(id) {
      const e = h('div', { class: 'node', dataset: { id }, role: 'button', 'aria-roledescription': 'idea' });
      e.appendChild(h('div', { class: 'txt' }));
      return e;
    }

    function renderAll() {
      if (!view) return;
      if (editing && !view.nodes[editing.id]) {
        editing.ta.remove();
        editing = null;
      }
      if (selected && !view.nodes[selected]) selected = null;
      const vis = visibleIds();
      const visSet = new Set(vis);
      const dragSet = drag && drag.moved ? new Set(D.subtreeIds(view, drag.id)) : null;
      const matchSet = new Set(search.open ? search.ids : []);
      const currentMatch = search.open && search.i >= 0 ? search.ids[search.i] : null;
      const peerSel = new Map();
      for (const p of peers.values()) for (const id of p.sel || []) {
        if (!peerSel.has(id)) peerSel.set(id, []);
        peerSel.get(id).push(p);
      }

      for (const id of vis) {
        const n = view.nodes[id];
        let e = nodeEls.get(id);
        if (!e) {
          e = makeNodeEl(id);
          nodeEls.set(id, e);
          nodesLayer.appendChild(e);
        }
        const isRoot = id === view.rootId;
        const isEdit = editing && editing.id === id;
        const text = isEdit ? editing.live : n.text;
        e.style.width = D.nodeSize(text, isRoot).w + 'px';
        let x = n.x;
        let y = n.y;
        if (dragSet && dragSet.has(id)) {
          x += drag.dx;
          y += drag.dy;
        }
        e.style.left = x + 'px';
        e.style.top = y + 'px';
        const peersHere = peerSel.get(id);
        e.className = 'node' + (isRoot ? ' root' : '') + (n.color !== 'default' ? ' n-' + n.color : '') + (id === selected ? ' selected' : '') +
          (isEdit ? ' editing' : '') + (dragSet && dragSet.has(id) ? ' dragging' : '') + (drag && drag.target === id ? ' drop-target' : '') + (peersHere ? ' peer-sel' : '') +
          (flashIds.has(id) ? ' flash' : '') + (matchSet.has(id) ? (id === currentMatch ? ' match match-current' : ' match') : '');
        if (peersHere) e.style.setProperty('--peer', peersHere[0].color);
        else e.style.removeProperty('--peer');
        e.setAttribute('aria-label', (n.text || 'Empty idea') + (n.children.length ? `, ${n.children.length} sub-ideas` : ''));
        e.setAttribute('aria-pressed', id === selected ? 'true' : 'false');

        let txt = e.querySelector('.txt');
        if (isEdit) {
          if (txt) txt.remove();
          if (!e.contains(editing.ta)) e.insertBefore(editing.ta, e.firstChild);
        } else {
          if (!txt) {
            txt = h('div', { class: 'txt' });
            e.insertBefore(txt, e.firstChild);
          }
          const shown = n.text || 'New idea';
          if (txt.textContent !== shown) txt.textContent = shown;
          txt.classList.toggle('placeholder', !n.text);
        }

        let fold = e.querySelector('.fold');
        if (n.children.length && !isRoot) {
          const right = D.sideOf(view, id) > 0;
          if (!fold) {
            fold = h('button', { class: 'fold', type: 'button', tabindex: '-1' });
            e.appendChild(fold);
          }
          fold.className = 'fold ' + (right ? 'r' : 'l');
          const isFolded = folded.has(id);
          fold.textContent = isFolded ? String(D.subtreeIds(view, id).length - 1) : '–';
          fold.setAttribute('aria-label', isFolded ? 'Unfold branch' : 'Fold branch');
          fold.title = isFolded ? 'Unfold branch' : 'Fold branch (only for you)';
        } else if (fold) fold.remove();

        for (const old of e.querySelectorAll('.peer-tag')) old.remove();
        if (peersHere) {
          peersHere.forEach((p, i) => {
            const tag = h('span', { class: 'peer-tag' }, p.name);
            tag.style.background = p.color;
            tag.style.top = -22 - i * 20 + 'px';
            e.appendChild(tag);
          });
        }
      }
      for (const [id, e] of nodeEls) {
        if (!visSet.has(id)) {
          e.remove();
          nodeEls.delete(id);
          nodeH.delete(id);
        }
      }
      for (const id of vis) nodeH.set(id, nodeEls.get(id).offsetHeight);
      if (editing) autosize(editing.ta);
      drawEdges(vis, dragSet);
      updateToolbar();
    }

    function drawEdges(vis, dragSet) {
      const frag = document.createDocumentFragment();
      const pos = (id) => {
        const n = view.nodes[id];
        const off = dragSet && dragSet.has(id) ? drag : null;
        const s = D.nodeSize(editing && editing.id === id ? editing.live : n.text, id === view.rootId);
        return { x: n.x + (off ? off.dx : 0), y: n.y + (off ? off.dy : 0), w: s.w, h: nodeH.get(id) || s.h };
      };
      for (const id of vis) {
        const n = view.nodes[id];
        if (!n.parent) continue;
        const p = pos(n.parent);
        const c = pos(id);
        const toRight = c.x + c.w / 2 >= p.x + p.w / 2;
        const x1 = toRight ? p.x + p.w : p.x;
        const y1 = p.y + p.h / 2;
        const x2 = toRight ? c.x : c.x + c.w;
        const y2 = c.y + c.h / 2;
        const mx = (x1 + x2) / 2;
        const path = document.createElementNS(SVGNS, 'path');
        path.setAttribute('d', `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
        if (n.color !== 'default') path.setAttribute('class', 'c-' + n.color);
        frag.appendChild(path);
      }
      edges.replaceChildren(frag);
    }

    function renderTitle() {
      const t = title;
      if (canEdit()) {
        let input = titleHolder.querySelector('input');
        if (!input) {
          input = h('input', { class: 'ed-title', type: 'text', maxlength: '120', 'aria-label': 'Map title' });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') {
              input.value = title;
              input.blur();
            }
          });
          input.addEventListener('change', async () => {
            const next = input.value.trim();
            if (!next || next === title) {
              input.value = title;
              return;
            }
            try {
              await ctx.api('PATCH', `/api/maps/${encodeURIComponent(mapId)}`, { title: next });
              title = next;
            } catch (e) {
              toast(e.message, { error: true });
              input.value = title;
            }
          });
          titleHolder.replaceChildren(input);
        }
        if (document.activeElement !== input) input.value = t;
      } else {
        titleHolder.replaceChildren(h('h1', { class: 'ed-title' }, t));
      }
      document.title = t + ' · Idea Map';
    }

    function renderPeers() {
      const byUser = new Map();
      for (const p of peers.values()) if (!byUser.has(p.userId)) byUser.set(p.userId, p);
      const list = [];
      if (me) list.push(avatar(me, 'You (' + me.name + ')'));
      for (const p of byUser.values()) if (!me || p.userId !== me.userId) list.push(avatar(p));
      const shown = list.slice(0, 6);
      if (list.length > 6) shown.push(h('span', { class: 'avatar', style: { background: '#5c7080' } }, '+' + (list.length - 6)));
      peersBox.replaceChildren(...shown);
    }

    function renderCursors() {
      const seen = new Set();
      for (const p of peers.values()) {
        if (p.x === undefined) continue;
        seen.add(p.c);
        let e = cursorEls.get(p.c);
        if (!e) {
          const svg = document.createElementNS(SVGNS, 'svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          const path = document.createElementNS(SVGNS, 'path');
          path.setAttribute('d', 'M3 2l17 8-7.5 2.2L9.5 20z');
          path.setAttribute('fill', p.color);
          path.setAttribute('stroke', '#fff');
          path.setAttribute('stroke-width', '1.5');
          svg.appendChild(path);
          const tag = h('span', { class: 'tag' }, p.name);
          tag.style.background = p.color;
          e = h('div', { class: 'cursor' }, svg, tag);
          cursorEls.set(p.c, e);
          cursorsLayer.appendChild(e);
        }
        e.style.transform = `translate(${p.x}px, ${p.y}px) scale(${1 / T.k})`;
        e.style.transformOrigin = '0 0';
      }
      for (const [c, e] of cursorEls) {
        if (!seen.has(c)) {
          e.remove();
          cursorEls.delete(c);
        }
      }
    }

    function updateToolbar() {
      const edit = canEdit();
      for (const el of editTools) el.classList.toggle('hidden', !edit);
      const n = selected && view ? view.nodes[selected] : null;
      bAddChild.disabled = !edit || !n || !connected;
      bAddSib.disabled = !edit || !n || !connected;
      bDelete.disabled = !edit || !n || !n.parent || !connected;
      bUndo.disabled = !edit || !connected;
      bRedo.disabled = !edit || !connected;
      bTidy.disabled = !edit || !connected;
      bFold.disabled = !n || !n.children.length || selected === (view && view.rootId);
      for (const s of swatches.children) {
        s.disabled = !edit || !n || !connected;
        s.setAttribute('aria-pressed', n && n.color === s.dataset.color ? 'true' : 'false');
      }
      hint.replaceChildren(...(edit
        ? [h('kbd', {}, 'Tab'), ' add idea · ', h('kbd', {}, 'Enter'), ' sibling · ', h('kbd', {}, 'F2'), ' edit · ', h('kbd', {}, 'Del'), ' delete · ', h('kbd', {}, 'Ctrl+Z'), ' undo · drag ideas to move or re-parent']
        : ['View only: pan, zoom and fold branches. Ask an admin for edit access.']));
      const vo = root.querySelector('.pill.viewonly');
      if (!edit && !vo) bar.insertBefore(h('span', { class: 'pill viewonly' }, 'View only'), status);
      if (edit && vo) vo.remove();
    }

    /* ---------- pointer handling ---------- */
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('textarea') || e.target.closest('.zoombar') || e.target.closest('.mapsearch')) return;
      if (window.IdeaMenu && window.IdeaMenu.isOpen()) window.IdeaMenu.close();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      if (pointers.size === 2) return startPinch();
      if (pointers.size > 2) return;
      const nodeEl = e.target.closest('.node');
      if (e.target.closest('.fold') && nodeEl) {
        e.preventDefault();
        toggleFold(nodeEl.dataset.id);
        return;
      }
      if (editing) finishEdit(true);
      canvas.focus({ preventScroll: true });
      if (nodeEl) {
        const id = nodeEl.dataset.id;
        setSelected(id);
        if (e.pointerType !== 'mouse') startLongPress(e, id);
        drag = canEdit() && connected ? { id, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false, target: null, pid: e.pointerId } : { id, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false, target: null, pid: e.pointerId, readOnly: true };
      } else {
        pan = { x: e.clientX, y: e.clientY, tx: T.tx, ty: T.ty, moved: false };
        canvas.classList.add('panning');
      }
    });

    function startPinch() {
      // A second finger turns whatever the first finger was doing into a pinch-zoom + pan.
      if (drag && drag.raf) cancelAnimationFrame(drag.raf);
      drag = null;
      pan = null;
      canvas.classList.remove('panning');
      const [a, b] = Array.from(pointers.values());
      const r = canvas.getBoundingClientRect();
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, k0: T.k, mx0: (a.x + b.x) / 2 - r.left, my0: (a.y + b.y) / 2 - r.top, tx0: T.tx, ty0: T.ty };
      renderAll();
    }

    function movePinch() {
      const [a, b] = Array.from(pointers.values());
      const r = canvas.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - r.left;
      const my = (a.y + b.y) / 2 - r.top;
      const k = Math.max(0.15, Math.min(2.5, pinch.k0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0)));
      const wx = (pinch.mx0 - pinch.tx0) / pinch.k0;
      const wy = (pinch.my0 - pinch.ty0) / pinch.k0;
      T.k = k;
      T.tx = mx - wx * k;
      T.ty = my - wy * k;
      applyTransform();
    }

    canvas.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) clearLongPress();
      if (pinch) {
        if (pointers.size >= 2) movePinch();
        return;
      }
      const now = performance.now();
      if (connected && now - lastCursorSent > 50) {
        lastCursorSent = now;
        const w = toWorld(e.clientX, e.clientY);
        send({ t: 'cursor', x: Math.round(w.x), y: Math.round(w.y) });
      }
      if (pan) {
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
        T.tx = pan.tx + dx;
        T.ty = pan.ty + dy;
        applyTransform();
      } else if (drag && !drag.readOnly) {
        const dxs = e.clientX - drag.sx;
        const dys = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dxs, dys) < 5) return;
        drag.moved = true;
        drag.dx = dxs / T.k;
        drag.dy = dys / T.k;
        drag.target = null;
        if (drag.id !== view.rootId) {
          const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.classList && el.classList.contains('node') && !el.classList.contains('dragging'));
          if (under) {
            const tid = under.dataset.id;
            if (tid !== drag.id && !D.isDescendant(view, tid, drag.id)) drag.target = tid;
          }
        }
        if (!drag.raf) {
          drag.raf = requestAnimationFrame(() => {
            if (drag) drag.raf = 0;
            renderAll();
          });
        }
      }
    });

    function endPointer(e, cancelled) {
      clearLongPress();
      pointers.delete(e.pointerId);
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        return;
      }
      if (pan) {
        const wasClick = !pan.moved;
        pan = null;
        canvas.classList.remove('panning');
        if (wasClick && !cancelled) setSelected(null);
      }
      if (drag) {
        const d = drag;
        drag = null;
        if (d.raf) cancelAnimationFrame(d.raf);
        if (d.moved && !cancelled) {
          const n = view.nodes[d.id];
          if (n) {
            if (d.target && view.nodes[d.target]) {
              const pos = D.suggestChildPos(view, d.target, undefined, n.text);
              if (folded.delete(d.target)) saveFolds();
              commit({ type: 'batch', ops: [
                { type: 'reparent', id: d.id, parent: d.target },
                { type: 'move', id: d.id, dx: Math.round(pos.x - n.x), dy: Math.round(pos.y - n.y) },
              ] });
            } else if (Math.abs(d.dx) + Math.abs(d.dy) > 0) {
              commit({ type: 'move', id: d.id, dx: Math.round(d.dx), dy: Math.round(d.dy) });
            }
          }
          renderAll();
        } else if (!d.moved && !cancelled) {
          const t = performance.now();
          if (lastTap.id === d.id && t - lastTap.t < 380) {
            lastTap = { id: null, t: 0 };
            startEdit(d.id, false);
          } else lastTap = { id: d.id, t };
          renderAll();
        } else renderAll();
      }
    }
    canvas.addEventListener('pointerup', (e) => endPointer(e, false));
    canvas.addEventListener('pointercancel', (e) => endPointer(e, true));

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      else {
        T.tx -= e.deltaX;
        T.ty -= e.deltaY;
        applyTransform();
      }
    }, { passive: false });

    /* ---------- keyboard ---------- */
    function neighbor(dir) {
      const cur = view.nodes[selected];
      if (!cur) return null;
      const cs = D.sizeOf(view, cur.id);
      const cx = cur.x + cs.w / 2;
      const cy = cur.y + (nodeH.get(cur.id) || cs.h) / 2;
      let best = null;
      let bestScore = Infinity;
      for (const id of visibleIds()) {
        if (id === cur.id) continue;
        const n = view.nodes[id];
        const s = D.sizeOf(view, id);
        const dx = n.x + s.w / 2 - cx;
        const dy = n.y + (nodeH.get(id) || s.h) / 2 - cy;
        const [main, cross] = dir === 'left' || dir === 'right' ? [dx, dy] : [dy, dx];
        const sign = dir === 'left' || dir === 'up' ? -1 : 1;
        if (main * sign <= 4) continue;
        const score = Math.abs(main) + 2.5 * Math.abs(cross);
        if (score < bestScore) {
          bestScore = score;
          best = id;
        }
      }
      return best;
    }

    function onKey(e) {
      if (closed || !view) return;
      if (window.IdeaMenu && window.IdeaMenu.isOpen()) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.overlay')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      if (mod && (key === 'z' || key === 'Z')) {
        e.preventDefault();
        if (canEdit()) send({ t: e.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (mod && (key === 'f' || key === 'F')) {
        e.preventDefault();
        openSearch();
        return;
      }
      if (mod && (key === 'y' || key === 'Y')) {
        e.preventDefault();
        if (canEdit()) send({ t: 'redo' });
        return;
      }
      if (mod || e.altKey) return;
      const sel = selected;
      if (key === 'Tab' && canEdit()) {
        e.preventDefault();
        addChild(sel || view.rootId);
      } else if (key === 'Enter' && canEdit()) {
        e.preventDefault();
        if (sel) addSibling(sel);
        else addChild(view.rootId);
      } else if ((key === 'F2' || key === ' ') && sel && canEdit()) {
        e.preventDefault();
        startEdit(sel, false);
      } else if ((key === 'Delete' || key === 'Backspace') && sel && canEdit()) {
        e.preventDefault();
        del(sel);
      } else if (key === 'Escape') {
        setSelected(null);
      } else if (key.startsWith('Arrow')) {
        e.preventDefault();
        if (!sel) return setSelected(view.rootId);
        const next = neighbor(key.slice(5).toLowerCase());
        if (next) setSelected(next);
      } else if (key === '?') showShortcuts();
      else if (key === '/') {
        e.preventDefault();
        openSearch();
      } else if (key === '+' || key === '=') zoomBy(1.25);
      else if (key === '-') zoomBy(1 / 1.25);
      else if (key === '0') fit();
    }
    document.addEventListener('keydown', onKey);

    /* ---------- flash, search, outline copy/paste, duplicate ---------- */
    const short = (t, n = 30) => {
      const x = String(t || '').replace(/\s+/g, ' ').trim();
      return x.length > n ? x.slice(0, n - 1) + '…' : x || 'New idea';
    };
    const isTyping = (t) => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const addedIds = (op) => (op && op.type === 'batch' ? op.ops : [op]).filter((o) => o && o.type === 'add').map((o) => o.id);

    function flash(ids) {
      if (!ids.length) return;
      for (const id of ids) flashIds.add(id);
      renderAll();
      setTimeout(() => {
        for (const id of ids) flashIds.delete(id);
        if (!closed) renderAll();
      }, 2300);
    }

    function centerOn(id) {
      const n = view.nodes[id];
      if (!n) return;
      const r = canvas.getBoundingClientRect();
      const s = D.sizeOf(view, id);
      T.k = Math.max(0.6, Math.min(1.4, T.k));
      T.tx = r.width / 2 - (n.x + s.w / 2) * T.k;
      T.ty = r.height / 2 - (n.y + s.h / 2) * T.k;
      applyTransform();
    }

    function runSearch(jump) {
      search.q = searchInput.value;
      search.ids = D.search(view, search.q);
      search.i = search.ids.length ? 0 : -1;
      searchCount.textContent = !search.q.trim() ? '' : search.ids.length ? `1 of ${search.ids.length}` : 'No matches';
      if (jump && search.i >= 0) showMatch();
      else renderAll();
    }

    function showMatch() {
      const id = search.ids[search.i];
      // unfold anything hiding the match, only for me
      let p = view.nodes[id] && view.nodes[id].parent;
      let changed = false;
      while (p) {
        if (folded.delete(p)) changed = true;
        p = view.nodes[p].parent;
      }
      if (changed) saveFolds();
      searchCount.textContent = `${search.i + 1} of ${search.ids.length}`;
      setSelected(id);
      renderAll();
      centerOn(id);
    }

    function gotoMatch(delta) {
      if (!search.ids.length) return;
      search.i = (search.i + delta + search.ids.length) % search.ids.length;
      showMatch();
    }

    function openSearch() {
      search.open = true;
      searchBar.classList.remove('hidden');
      searchInput.focus();
      searchInput.select();
      runSearch(false);
    }

    function closeSearch() {
      search = { open: false, q: '', ids: [], i: -1 };
      searchBar.classList.add('hidden');
      searchInput.value = '';
      renderAll();
      canvas.focus({ preventScroll: true });
    }

    searchInput.addEventListener('input', () => runSearch(true));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        gotoMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
      }
      e.stopPropagation();
    });

    function copyOutline(id) {
      const text = D.toOutline(view, id);
      const n = D.subtreeIds(view, id).length;
      const done = () => toast(n === 1 ? 'Copied the idea as text.' : `Copied ${n} ideas as an outline.`);
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => toast('Your browser blocked copying. Select the idea and press Ctrl+C.', { error: true }));
      else toast('Your browser blocked copying. Select the idea and press Ctrl+C.', { error: true });
    }

    function pasteText(text, parentId) {
      if (!canEdit()) return toast('You have view-only access to this map.');
      const r = D.opsFromOutline(view, parentId, text);
      if (r.error) return toast(r.error, { error: true });
      if (!commit(r.op)) return;
      if (folded.delete(parentId)) saveFolds();
      flash(addedIds(r.op));
      toast(`Pasted ${r.count} idea${r.count === 1 ? '' : 's'}.` + (r.truncated ? ' Only the first 240 lines were used.' : '') + ' Ctrl+Z undoes it.');
    }

    function pasteFromClipboard(parentId) {
      if (!navigator.clipboard || !navigator.clipboard.readText) return toast('Select the idea and press Ctrl+V to paste.');
      navigator.clipboard.readText().then((t) => pasteText(t, parentId), () => toast('Your browser blocked clipboard access. Select the idea and press Ctrl+V instead.', { error: true }));
    }

    function duplicate(id) {
      const r = D.duplicateBranch(view, id);
      if (r.error) return toast(r.error, { error: true });
      if (!commit(r.op)) return;
      setSelected(r.newRoot);
      flash(addedIds(r.op));
      toast(`Duplicated ${r.count} idea${r.count === 1 ? '' : 's'}.`);
    }

    function foldAll(on) {
      if (on) for (const id of Object.keys(view.nodes)) { if (id !== view.rootId && view.nodes[id].children.length) folded.add(id); }
      else folded.clear();
      saveFolds();
      renderAll();
      fit();
    }

    const interactive = () => !closed && view && document.activeElement && (document.activeElement === canvas || document.activeElement === document.body) && !document.querySelector('.overlay');
    function onCopy(e) {
      if (!interactive() || !selected || isTyping(e.target) || String(window.getSelection && window.getSelection()).trim()) return;
      e.clipboardData.setData('text/plain', D.toOutline(view, selected));
      e.preventDefault();
      const n = D.subtreeIds(view, selected).length;
      toast(n === 1 ? 'Copied the idea as text.' : `Copied ${n} ideas as an outline.`);
    }
    function onPaste(e) {
      if (!interactive() || isTyping(e.target) || !canEdit()) return;
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text || !text.trim()) return;
      e.preventDefault();
      pasteText(text, selected || view.rootId);
    }
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);

    function showShortcuts() {
      const row = (k, d) => h('tr', {}, h('td', {}, k), h('td', {}, d));
      const group = (t) => h('tr', {}, h('td', { colspan: '2' }, h('h3', {}, t)));
      modal({
        title: 'Keyboard shortcuts',
        content: h('table', { class: 'keys' }, h('tbody', {},
          group('Ideas'),
          row(h('kbd', {}, 'Tab'), 'Add a child idea'), row(h('kbd', {}, 'Enter'), 'Add a sibling idea'), row(h('kbd', {}, 'F2'), 'Edit the selected idea (or double-click)'),
          row(h('kbd', {}, 'Delete'), 'Delete the idea and its branch'), row(h('kbd', {}, 'Ctrl+Z'), 'Undo your last change (Ctrl+Shift+Z to redo)'),
          row(h('kbd', {}, 'Ctrl+C'), 'Copy the branch as an outline'), row(h('kbd', {}, 'Ctrl+V'), 'Paste an outline as ideas under the selected idea'),
          group('Moving around'),
          row(h('kbd', {}, 'Arrow keys'), 'Select the neighbouring idea'), row(h('kbd', {}, 'Ctrl+F'), 'Find an idea (or press /)'),
          row(h('kbd', {}, '+  −  0'), 'Zoom in, out, fit to screen'), row('Scroll', 'Pan; hold Ctrl and scroll to zoom'),
          group('Mouse and touch'),
          row('Right-click', 'Menu for an idea or the empty board (long-press on a phone)'), row('Drag an idea', 'Move it; drop it on another idea to re-parent it'),
          row('Pinch', 'Zoom on a touch screen'))),
        buttons: [{ label: 'Close', primary: true }],
      });
    }

    /* ---------- right-click / long-press menu ---------- */
    const PROMPTS = {
      brainstorm: 'Brainstorm six specific sub-ideas under the selected idea.',
      reword: 'Rewrite the selected idea, and any ideas beneath it, so the wording is clearer and more concrete. Keep the meaning.',
      expand: 'Turn the selected idea into a short plan: add the key steps or sub-topics as sub-ideas beneath it.',
    };

    function nodeMenu(id) {
      const n = view.nodes[id];
      const isRoot = !n.parent;
      const edit = canEdit() && connected;
      const items = [{ heading: short(n.text) }];
      if (canEdit()) {
        items.push(
          { label: 'Edit text', hint: 'F2', icon: 'edit', disabled: !edit, onClick: () => startEdit(id, false) },
          { label: 'Add child idea', hint: 'Tab', icon: 'child', disabled: !edit, onClick: () => addChild(id) },
          { label: 'Add sibling', hint: 'Enter', icon: 'sibling', disabled: !edit || isRoot, onClick: () => addSibling(id) },
          { label: 'Duplicate branch', icon: 'copy', disabled: !edit || isRoot, onClick: () => duplicate(id) },
          { separator: true },
          { colors: { current: n.color, onPick: (c) => setColor(id, c) } },
          { separator: true });
      }
      items.push({ label: 'Copy as outline', hint: 'Ctrl+C', icon: 'copy', onClick: () => copyOutline(id) });
      if (canEdit()) items.push({ label: 'Paste ideas here', hint: 'Ctrl+V', icon: 'paste', disabled: !edit, onClick: () => pasteFromClipboard(id) });
      if (n.children.length && !isRoot) items.push({ label: folded.has(id) ? 'Unfold branch' : 'Fold branch', icon: 'fold', onClick: () => toggleFold(id) });
      if (canEdit() && ai.enabled) {
        items.push({ separator: true }, { heading: 'Claude' },
          { label: 'Brainstorm sub-ideas', icon: 'spark', disabled: !edit, onClick: () => ai.ask(PROMPTS.brainstorm) },
          { label: 'Expand into a plan', icon: 'spark', disabled: !edit, onClick: () => ai.ask(PROMPTS.expand) },
          { label: 'Reword this idea', icon: 'spark', disabled: !edit, onClick: () => ai.ask(PROMPTS.reword) },
          { label: 'Ask Claude…', icon: 'spark', onClick: () => ai.open() });
      }
      if (canEdit()) items.push({ separator: true }, { label: 'Delete', hint: 'Del', icon: 'trash', danger: true, disabled: !edit || isRoot, onClick: () => del(id) });
      return items;
    }

    function canvasMenu() {
      const edit = canEdit() && connected;
      const items = [{ heading: 'Board' }];
      if (canEdit()) {
        items.push(
          { label: 'Add idea to the central idea', icon: 'child', disabled: !edit, onClick: () => addChild(view.rootId) },
          { label: 'Paste ideas', hint: 'Ctrl+V', icon: 'paste', disabled: !edit, onClick: () => pasteFromClipboard(selected || view.rootId) },
          { label: 'Tidy layout', icon: 'tidy', disabled: !edit, onClick: () => tidy() },
          { separator: true });
      }
      items.push(
        { label: 'Fit to screen', hint: '0', icon: 'fit', onClick: () => fit() },
        { label: 'Find an idea…', hint: 'Ctrl+F', icon: 'search', onClick: () => openSearch() },
        { label: 'Fold all branches', icon: 'fold', onClick: () => foldAll(true) },
        { label: 'Unfold all branches', icon: 'expand', onClick: () => foldAll(false) });
      if (canEdit() && ai.enabled) items.push({ separator: true }, { label: 'Ask Claude…', icon: 'spark', onClick: () => ai.open() });
      items.push({ separator: true },
        { label: 'Download as image (PNG)', icon: 'image', onClick: () => exportPng() },
        { label: 'Download as JSON', icon: 'download', onClick: () => download(`/api/maps/${encodeURIComponent(mapId)}/export`, '') },
        { label: 'Keyboard shortcuts', hint: '?', icon: 'help', onClick: () => showShortcuts() });
      return items;
    }

    function showMenu(id, x, y, touch) {
      if (!view) return;
      window.IdeaMenu.open({ touch, x, y, items: id && view.nodes[id] ? nodeMenu(id) : canvasMenu(), label: id ? 'Idea actions' : 'Board actions' });
    }

    canvas.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.zoombar') || e.target.closest('.mapsearch') || e.target.closest('textarea')) return;
      e.preventDefault();
      if (!view) return;
      clearLongPress();
      if (editing) finishEdit(true);
      const nodeEl = e.target.closest('.node');
      let id = nodeEl ? nodeEl.dataset.id : null;
      let x = e.clientX;
      let y = e.clientY;
      // Menu key or Shift+F10 on the focused canvas: open the menu on the selected idea
      if (!id && (e.button === 0 || (x === 0 && y === 0)) && selected && nodeEls.get(selected)) {
        const r = nodeEls.get(selected).getBoundingClientRect();
        id = selected;
        x = r.left + r.width / 2;
        y = r.bottom;
      }
      if (id) setSelected(id);
      showMenu(id, x, y);
    });

    function startLongPress(e, id) {
      clearLongPress();
      lp = { id, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
        if (!lp) return;
        const { id: lid, x, y } = lp;
        lp = null;
        drag = null;
        showMenu(lid, x, y, true);
      }, 550) };
    }
    function clearLongPress() {
      if (lp) {
        clearTimeout(lp.timer);
        lp = null;
      }
    }

    /* ---------- PNG export ---------- */
    function roundRect(c, x, y, w, hh, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + hh, r);
      c.arcTo(x + w, y + hh, x, y + hh, r);
      c.arcTo(x, y + hh, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    function wrapText(c, text, maxW) {
      const lines = [];
      for (const para of String(text || '').split('\n')) {
        let line = '';
        for (const word of para.split(/(\s+)/)) {
          if (!word) continue;
          if (c.measureText(line + word).width <= maxW) {
            line += word;
            continue;
          }
          if (line.trim()) lines.push(line.trimEnd());
          line = '';
          let rest = word.trimStart();
          while (c.measureText(rest).width > maxW && rest.length > 1) {
            let i = rest.length - 1;
            while (i > 1 && c.measureText(rest.slice(0, i)).width > maxW) i--;
            lines.push(rest.slice(0, i));
            rest = rest.slice(i);
          }
          line = rest;
        }
        lines.push(line.trimEnd());
      }
      return lines;
    }

    async function exportPng() {
      if (!view) return;
      try { await document.fonts.ready; } catch { /* old browsers */ }
      const ids = visibleIds();
      const b = bounds(ids);
      const pad = 48;
      const W = b.x1 - b.x0 + pad * 2;
      const H = b.y1 - b.y0 + pad * 2;
      const scale = Math.min(2, 8000 / Math.max(W, H));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.ceil(W * scale));
      cv.height = Math.max(1, Math.ceil(H * scale));
      const c = cv.getContext('2d');
      c.scale(scale, scale);
      const css = getComputedStyle(document.documentElement);
      const v = (name) => css.getPropertyValue(name).trim();
      c.fillStyle = v('--canvas-bg') || '#fff';
      c.fillRect(0, 0, W, H);
      c.translate(pad - b.x0, pad - b.y0);
      const geo = (id) => {
        const n = view.nodes[id];
        const s = D.sizeOf(view, id);
        return { x: n.x, y: n.y, w: s.w, h: nodeH.get(id) || s.h };
      };
      c.lineWidth = 2;
      c.lineCap = 'round';
      for (const id of ids) {
        const n = view.nodes[id];
        if (!n.parent) continue;
        const p = geo(n.parent);
        const k = geo(id);
        const right = k.x + k.w / 2 >= p.x + p.w / 2;
        const x1 = right ? p.x + p.w : p.x;
        const y1 = p.y + p.h / 2;
        const x2 = right ? k.x : k.x + k.w;
        const y2 = k.y + k.h / 2;
        c.strokeStyle = n.color !== 'default' ? v('--nc-' + n.color + '-bd') : v('--edge');
        c.beginPath();
        c.moveTo(x1, y1);
        c.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
        c.stroke();
      }
      for (const id of ids) {
        const n = view.nodes[id];
        const g = geo(id);
        const isRoot = id === view.rootId;
        let fill = v('--nc-' + n.color + '-bg');
        let stroke = v('--nc-' + n.color + '-bd');
        let ink = v('--text');
        if (isRoot) {
          fill = n.color === 'default' ? v('--root-bg') : stroke;
          stroke = fill;
          ink = n.color === 'amber' ? '#231a00' : v('--root-ink');
        }
        roundRect(c, g.x + 1, g.y + 1, g.w - 2, g.h - 2, 12);
        c.fillStyle = fill;
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = stroke;
        c.stroke();
        c.fillStyle = ink;
        c.textBaseline = 'alphabetic';
        c.font = (isRoot ? '600 16px' : '500 14px') + ' "IBM Plex Sans", system-ui, sans-serif';
        const lines = wrapText(c, n.text || 'New idea', g.w - 32);
        const top = g.y + (g.h - lines.length * 20) / 2;
        lines.forEach((ln, i) => c.fillText(ln, g.x + 16, top + i * 20 + 15));
        if (folded.has(id)) {
          c.font = '600 11px "IBM Plex Sans", sans-serif';
          c.fillStyle = v('--muted');
          c.fillText('+' + (D.subtreeIds(view, id).length - 1) + ' folded', g.x + 4, g.y + g.h + 14);
        }
      }
      c.setTransform(scale, 0, 0, scale, 0, 0);
      c.font = '500 11px "IBM Plex Sans", sans-serif';
      c.fillStyle = v('--muted');
      c.textAlign = 'right';
      c.fillText('Idea Map · Aligned', W - 14, H - 12);
      cv.toBlob((blob) => {
        if (!blob) return toast('Could not create the image', { error: true });
        const url = URL.createObjectURL(blob);
        const slug = (title || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
        download(url, slug + '.png');
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      }, 'image/png');
    }

    /* ---------- boot ---------- */
    applyTransform();
    updateToolbar();
    ctx.api('GET', `/api/maps/${encodeURIComponent(mapId)}`).then(
      () => connect(),
      (e) => {
        toast(e.status === 404 ? 'That map no longer exists.' : e.message, { error: true });
        if (e.status !== 401) ctx.navigate('#/');
      }
    );

    return {
      destroy() {
        closed = true;
        clearTimeout(reconnectTimer);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('copy', onCopy);
        document.removeEventListener('paste', onPaste);
        clearLongPress();
        if (window.IdeaMenu) window.IdeaMenu.close();
        if (ws) ws.close();
        container.replaceChildren();
      },
    };
  }

  window.IdeaEditor = { open };
})();
