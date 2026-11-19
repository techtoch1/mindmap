/*
 * "Ask Claude" side panel.
 *
 * Claude answers with a proposal. In auto mode, a proposal made only of non-destructive changes is applied
 * straight away (through the normal editing path, as ONE undo step) and the card offers Undo. A proposal
 * that deletes ideas is never applied without a click, in any mode.
 */
(function () {
  'use strict';
  const { h, icon, toast } = window.IdeaUI;
  const AUTO_KEY = 'ideamap-ai-auto';

  const SUGGESTIONS = [
    ['Brainstorm here', 'Brainstorm six specific, non-obvious ideas under the selected idea (or under the central idea if nothing is selected).'],
    ['Group by theme', 'Group the existing ideas into clear themes, give each theme its own colour, and tidy the layout.'],
    ['Tighten wording', 'Rewrite any idea that is vague or too long so it is short and concrete. Keep the meaning.'],
    ['What is missing?', 'Look at this map and tell me what is missing. Add the most valuable gaps as new ideas.'],
  ];

  function readAuto() {
    try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch { return true; }
  }
  function writeAuto(on) {
    try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  }

  function create({ mapId, api, enabled, isAdmin, autoAllowed, getSelected, apply, undo }) {
    const history = []; // { role, content } for earlier turns
    let busy = false;
    let openCard = null; // the one card with buttons that still work
    let auto = autoAllowed && readAuto();

    const log = h('div', { class: 'ai-log', role: 'log', 'aria-live': 'polite' });
    const input = h('textarea', { class: 'input ai-input', rows: '2', maxlength: '2000', placeholder: 'Ask Claude, e.g. “Add 6 LinkedIn post ideas under Channels”', 'aria-label': 'Message to Claude' });
    const send = h('button', { class: 'btn primary', type: 'button' }, 'Send');
    const chips = h('div', { class: 'ai-chips' }, SUGGESTIONS.map(([label, text]) => h('button', { class: 'btn sm', type: 'button', onclick: () => submit(text) }, label)));
    const newChat = h('button', { class: 'btn ghost sm', type: 'button', title: 'Start a new conversation', onclick: reset }, 'New chat');
    const closeBtn = h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Close Claude panel', onclick: () => panel.classList.add('hidden') }, icon('plus'));
    closeBtn.firstChild.style.transform = 'rotate(45deg)';

    const autoBox = h('input', { type: 'checkbox', id: 'ai-auto-' + mapId, checked: auto || undefined, disabled: !autoAllowed || undefined });
    autoBox.checked = auto;
    autoBox.addEventListener('change', () => {
      auto = autoBox.checked;
      writeAuto(auto);
    });
    const autoRow = h('label', { class: 'ai-toggle', for: 'ai-auto-' + mapId }, autoBox,
      h('span', {}, autoAllowed
        ? 'Let Claude apply changes straight away. You can undo with Ctrl+Z, and anything that deletes ideas always asks first.'
        : 'Your admin asks that every Claude change is reviewed before it is applied.'));

    const off = h('div', { class: 'ai-off' },
      h('strong', {}, 'Claude is not switched on yet.'),
      h('p', {}, isAdmin
        ? 'Add your Anthropic API key on the Settings page, then come back here.'
        : 'An admin needs to add the Claude API key on the Settings page first.'),
      isAdmin ? h('a', { class: 'btn primary', href: '#/settings' }, icon('settings'), 'Open Settings') : null);

    const body = enabled
      ? [log, chips, autoRow, h('div', { class: 'ai-compose' }, input, h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, 'Ideas on this map are sent to Claude to answer you.'), send))]
      : [off];

    const panel = h('aside', { class: 'ai-panel hidden', 'aria-label': 'Ask Claude' },
      h('div', { class: 'ai-head' }, h('strong', {}, 'Ask Claude'), h('span', { class: 'grow' }), enabled ? newChat : null, closeBtn), ...body);

    function bubble(role, text) {
      const b = h('div', { class: 'ai-msg ' + role }, text);
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      return b;
    }

    function reset() {
      if (busy) return;
      history.length = 0;
      openCard = null;
      log.replaceChildren();
      greet();
    }

    function greet() {
      bubble('assistant', 'Hi! Tell me what to add or change on this map, or right-click an idea and pick a Claude action. Select an idea first and I will work on that one.');
    }

    function changeList(result) {
      const list = h('ul', { class: 'ai-changes' });
      const shown = result.changes.slice(0, 14);
      for (const c of shown) list.appendChild(h('li', { class: 'k-' + c.kind }, c.label));
      if (result.changes.length > shown.length) list.appendChild(h('li', { class: 'muted' }, `…and ${result.changes.length - shown.length} more`));
      return list;
    }

    const summary = (result) => result.changes.length + (result.changes.length === 1 ? ' change' : ' changes') +
      (result.skipped ? ` · ${result.skipped} suggestion${result.skipped === 1 ? '' : 's'} skipped (they did not fit the map)` : '');

    // Claude already did it: show what changed, with Undo.
    function appliedCard(result) {
      const undoBtn = h('button', { class: 'btn sm', type: 'button' }, 'Undo');
      const status = h('span', { class: 'small muted grow' }, 'Applied · ' + summary(result));
      const card = h('div', { class: 'ai-card applied' }, h('strong', {}, 'Claude made these changes'), changeList(result), h('div', { class: 'row' }, status, undoBtn));
      const entry = { finish: (t) => { undoBtn.remove(); if (t) status.textContent = t; } };
      undoBtn.addEventListener('click', () => {
        undo();
        entry.finish('Undone');
        if (openCard === entry) openCard = null;
      });
      openCard = entry;
      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
    }

    // Needs a decision: review mode, or the proposal deletes ideas.
    function proposalCard(result) {
      const status = h('span', { class: 'small muted grow' }, summary(result));
      const applyBtn = h('button', { class: 'btn primary sm', type: 'button' }, result.destructive ? 'Apply and delete' : 'Apply');
      const dismissBtn = h('button', { class: 'btn sm', type: 'button' }, 'Dismiss');
      const card = h('div', { class: 'ai-card' },
        h('strong', {}, 'Proposed changes'),
        result.destructive ? h('div', { class: 'ai-note' }, 'This includes deleting ideas, so nothing happens until you confirm.') : null,
        changeList(result), h('div', { class: 'row' }, status, dismissBtn, applyBtn));
      const entry = { finish: (t) => { applyBtn.remove(); dismissBtn.remove(); status.textContent = t; } };
      applyBtn.addEventListener('click', () => {
        if (apply(result.ops)) {
          entry.finish('Applied. Press Ctrl+Z to undo all of it.');
          if (openCard === entry) openCard = null;
        } else entry.finish('Could not apply (the map changed). Ask again.');
      });
      dismissBtn.addEventListener('click', () => {
        entry.finish('Dismissed');
        if (openCard === entry) openCard = null;
      });
      openCard = entry;
      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
    }

    async function submit(text) {
      const message = (text || input.value).trim();
      if (!message || busy || !enabled) return;
      if (openCard) {
        openCard.finish('Replaced by a newer request');
        openCard = null;
      }
      busy = true;
      send.disabled = true;
      input.value = '';
      bubble('user', message);
      const wait = bubble('assistant thinking', 'Claude is thinking…');
      try {
        const r = await api('POST', `/api/maps/${encodeURIComponent(mapId)}/ai`, { message, selected: getSelected() || undefined, history: history.slice(-10) });
        wait.remove();
        history.push({ role: 'user', content: message }, { role: 'assistant', content: r.reply });
        bubble('assistant', r.reply);
        if (r.ops && r.changes.length) {
          if (auto && autoAllowed && !r.destructive) {
            if (apply(r.ops)) appliedCard(r);
            else proposalCard(r); // the map changed in the meantime: let the person decide
          } else proposalCard(r);
        }
      } catch (e) {
        wait.remove();
        bubble('assistant error', e.message);
        if (e.status && e.status !== 409) toast(e.message, { error: true });
      } finally {
        busy = false;
        send.disabled = false;
        if (!panel.classList.contains('hidden')) input.focus();
      }
    }

    send.addEventListener('click', () => submit());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
      e.stopPropagation();
    });

    if (enabled) greet();
    const api2 = {
      el: panel,
      enabled,
      open() {
        panel.classList.remove('hidden');
        if (enabled) input.focus();
      },
      close() {
        panel.classList.add('hidden');
      },
      toggle() {
        if (panel.classList.contains('hidden')) api2.open();
        else api2.close();
      },
      // Right-click quick actions: open the panel and send a ready-made request.
      ask(text) {
        api2.open();
        submit(text);
      },
    };
    return api2;
  }

  window.IdeaAiPanel = { create };
})();
