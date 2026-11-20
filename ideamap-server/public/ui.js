/* Small DOM helpers. Everything is built with createElement/textContent: no innerHTML, so user text can never become markup. */
(function () {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    append(el, kids);
    return el;
  }

  function append(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else if (k instanceof Node) el.appendChild(k);
      else el.appendChild(document.createTextNode(String(k)));
    }
  }

  const ICONS = {
    search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M21 21l-4.3-4.3' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    minus: [['path', { d: 'M5 12h14' }]],
    undo: [['path', { d: 'M9 14L4 9l5-5' }], ['path', { d: 'M4 9h10a6 6 0 010 12h-3' }]],
    redo: [['path', { d: 'M15 14l5-5-5-5' }], ['path', { d: 'M20 9H10a6 6 0 000 12h3' }]],
    tidy: [['circle', { cx: 12, cy: 12, r: 2.5 }], ['path', { d: 'M12 9.5V5M9.8 13.4L6.4 16M14.2 13.4L17.6 16' }], ['circle', { cx: 12, cy: 4, r: 1.5 }], ['circle', { cx: 5.5, cy: 17, r: 1.5 }], ['circle', { cx: 18.5, cy: 17, r: 1.5 }]],
    download: [['path', { d: 'M12 3v12m0 0l-4-4m4 4l4-4M4 21h16' }]],
    upload: [['path', { d: 'M12 15V3m0 0L8 7m4-4l4 4M4 21h16' }]],
    image: [['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ['circle', { cx: 8.5, cy: 8.5, r: 1.5 }], ['path', { d: 'M21 15l-5-5L5 21' }]],
    trash: [['path', { d: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6' }]],
    copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1' }]],
    edit: [['path', { d: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z' }]],
    fit: [['path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5' }]],
    sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }]],
    moon: [['path', { d: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z' }]],
    logout: [['path', { d: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9' }]],
    users: [['path', { d: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['path', { d: 'M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8' }]],
    key: [['circle', { cx: 8, cy: 15, r: 4 }], ['path', { d: 'M10.8 12.2L21 2M16 7l3 3' }]],
    back: [['path', { d: 'M15 18l-6-6 6-6' }]],
    fold: [['path', { d: 'M6 9l6 6 6-6' }]],
    child: [['path', { d: 'M5 4v10a3 3 0 003 3h11M15 13l4 4-4 4' }]],
    settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z' }]],
    palette: [['circle', { cx: 12, cy: 12, r: 9 }], ['circle', { cx: 8, cy: 10, r: 1.2 }], ['circle', { cx: 12, cy: 7, r: 1.2 }], ['circle', { cx: 16, cy: 10, r: 1.2 }], ['path', { d: 'M12 21a2.5 2.5 0 002.5-2.5c0-1.4-1.1-1.8-1.1-2.9s.9-1.6 2.3-1.6H18' }]],
    chat: [['path', { d: 'M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z' }]],
    send: [['path', { d: 'M22 2L11 13M22 2l-7 20-4-9-9-4z' }]],
    spark: [['path', { d: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z' }], ['path', { d: 'M19 3v4M17 5h4M5 17v4M3 19h4' }]],
    help: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M9.1 9a3 3 0 015.8 1c0 2-3 2.5-3 4.5M12 17.5h.01' }]],
    expand: [['path', { d: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5' }]],
    paste: [['rect', { x: 8, y: 2, width: 8, height: 4, rx: 1 }], ['path', { d: 'M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2' }]],
    sibling: [['path', { d: 'M4 6h10M4 18h10M4 6v12M14 12h6M17 9l3 3-3 3' }]],
  };

  function icon(name) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of ICONS[name] || []) {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      svg.appendChild(e);
    }
    return svg;
  }

  function logo() {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('aria-hidden', 'true');
    const mk = (tag, a) => {
      const e = document.createElementNS(SVGNS, tag);
      for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
      svg.appendChild(e);
    };
    mk('rect', { width: 32, height: 32, rx: 8, fill: '#187bcd' });
    mk('path', { d: 'M16 16L8 9M16 16L24 9M16 16L8 23M16 16L24 23', stroke: '#fff', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round' });
    mk('circle', { cx: 16, cy: 16, r: 4.5, fill: '#fff' });
    for (const [cx, cy] of [[8, 9], [24, 9], [8, 23], [24, 23]]) mk('circle', { cx, cy, r: 2.4, fill: '#fff' });
    return svg;
  }

  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
  }

  function avatar(user, title) {
    const a = h('span', { class: 'avatar', title: title || user.name, 'aria-label': title || user.name }, initials(user.name));
    a.style.background = user.color || '#5c7080';
    return a;
  }

  function toast(message, opts) {
    const host = document.getElementById('toasts');
    if (!host) return;
    const t = h('div', { class: 'toast' + (opts && opts.error ? ' err' : '') }, message);
    host.appendChild(t);
    setTimeout(() => t.remove(), opts && opts.error ? 6000 : 3500);
  }

  // modal({ title, content, buttons:[{label, primary, danger, onClick}] }) -> { close }
  // A button's onClick may return false (or a promise resolving to false) to keep the dialog open.
  function modal({ title, content, buttons, onClose }) {
    const previous = document.activeElement;
    const titleId = 'm' + Math.random().toString(36).slice(2, 8);
    const overlay = h('div', { class: 'overlay' });
    const foot = h('div', { class: 'foot' });
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, h('h2', { id: titleId }, title), content, foot);
    overlay.appendChild(box);
    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previous && previous.focus) previous.focus();
      if (onClose) onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    }
    for (const b of buttons || []) {
      const btn = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), type: 'button' }, b.label);
      btn.addEventListener('click', async () => {
        if (!b.onClick) return close();
        btn.disabled = true;
        let keep;
        try {
          keep = await b.onClick();
        } finally {
          btn.disabled = false;
        }
        if (keep !== false) close();
      });
      foot.appendChild(btn);
    }
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    const first = box.querySelector('input, select, textarea, button.tpl');
    (first || box.querySelector('button')).focus();
    return { close, box };
  }

  function relTime(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + ' d ago';
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function download(url, name) {
    const a = h('a', { href: url, download: name || '' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  window.IdeaUI = { h, icon, logo, avatar, initials, toast, modal, relTime, download };
})();
