/*
 * Right-click / long-press menu. One menu at a time, keyboard accessible (arrows, Enter, Esc),
 * clamped to the viewport, closes on outside click, scroll, resize or focus loss.
 * items: { label, hint, icon, onClick, disabled, danger } | { heading } | { separator: true } | { colors: { current, onPick } }
 */
(function () {
  'use strict';
  const { h, icon } = window.IdeaUI;
  const COLOR_NAMES = { default: 'Default', blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', purple: 'Purple', teal: 'Teal', grey: 'Grey' };
  let current = null;

  function close(restoreFocus) {
    if (!current) return;
    const c = current;
    current = null;
    c.el.remove();
    document.removeEventListener('pointerdown', c.onOutside, true);
    document.removeEventListener('keydown', c.onKey, true);
    window.removeEventListener('resize', c.onAway);
    window.removeEventListener('blur', c.onAway);
    document.removeEventListener('scroll', c.onAway, true);
    if (c.onUp) document.removeEventListener('pointerup', c.onUp, true);
    if (restoreFocus && c.previous && c.previous.focus) c.previous.focus({ preventScroll: true });
    if (c.onClose) c.onClose();
  }

  // `touch`: opened by a long-press. The finger is still down and, once lifted, the browser sends a synthetic
  // click to that spot, which must not activate the item that happens to be under it.
  function open({ x, y, items, label, onClose, touch }) {
    close(false);
    const previous = document.activeElement;
    const el = h('div', { class: 'ctx-menu', role: 'menu', 'aria-label': label || 'Menu' });
    const run = (fn) => () => {
      close(true);
      if (fn) fn();
    };
    for (const it of items) {
      if (!it) continue;
      if (it.separator) el.appendChild(h('div', { class: 'ctx-sep', role: 'separator' }));
      else if (it.heading) el.appendChild(h('div', { class: 'ctx-head', role: 'presentation' }, it.heading));
      else if (it.colors) {
        // Each colour shows what it means in this map (the colour key), as a tooltip and in the line underneath.
        const meanings = it.colors.labels || {};
        const name = (c) => COLOR_NAMES[c] + (meanings[c] ? ': ' + meanings[c] : '');
        const caption = (c) => (meanings[c] ? name(c) : COLOR_NAMES[c] + ' (no meaning set yet)');
        const cap = h('div', { class: 'ctx-colorcap', 'aria-live': 'polite' }, caption(it.colors.current));
        const swatchBtns = Object.keys(COLOR_NAMES).map((c) => {
          const b = h('button', { class: 'sw c-' + c, type: 'button', role: 'menuitemradio', 'aria-checked': it.colors.current === c ? 'true' : 'false', 'aria-pressed': it.colors.current === c ? 'true' : 'false', title: name(c), 'aria-label': name(c), onclick: run(() => it.colors.onPick(c)) });
          const show = () => { cap.textContent = caption(c); };
          const reset = () => { cap.textContent = caption(it.colors.current); };
          b.addEventListener('mouseenter', show);
          b.addEventListener('focus', show);
          b.addEventListener('mouseleave', reset);
          b.addEventListener('blur', reset);
          return b;
        });
        el.appendChild(h('div', { class: 'ctx-colors', role: 'group', 'aria-label': 'Colour' }, swatchBtns));
        el.appendChild(cap);
      } else {
        el.appendChild(h('button', { class: 'ctx-item' + (it.danger ? ' danger' : ''), type: 'button', role: 'menuitem', disabled: it.disabled || undefined, onclick: run(it.onClick) },
          it.icon ? icon(it.icon) : h('span', { class: 'ctx-icon' }),
          h('span', { class: 'ctx-label' }, it.label),
          it.hint ? h('kbd', {}, it.hint) : null));
      }
    }
    el.style.left = '0px';
    el.style.top = '0px';
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    const top = touch ? y - r.height - 24 >= 8 ? y - r.height - 24 : y + 28 : y; // clear of the fingertip
    el.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    el.style.top = Math.max(8, Math.min(top, window.innerHeight - r.height - 8)) + 'px';
    let guardUntil = touch ? Infinity : 0;
    el.addEventListener('click', (e) => {
      if (performance.now() < guardUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    const onUp = () => {
      guardUntil = performance.now() + 600;
      document.removeEventListener('pointerup', onUp, true);
    };
    if (touch) document.addEventListener('pointerup', onUp, true);

    const buttons = () => Array.from(el.querySelectorAll('button:not([disabled])'));
    const onOutside = (e) => { if (!el.contains(e.target)) close(false); };
    const onAway = () => close(false);
    const onKey = (e) => {
      const list = buttons();
      const i = list.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); close(true); }
    };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onAway);
    window.addEventListener('blur', onAway);
    document.addEventListener('scroll', onAway, true);
    current = { el, previous, onOutside, onKey, onAway, onClose, onUp: touch ? onUp : null };
    const first = buttons()[0];
    if (first) first.focus({ preventScroll: true });
    return { close: () => close(true) };
  }

  window.IdeaMenu = { open, close: () => close(false), isOpen: () => !!current };
})();
