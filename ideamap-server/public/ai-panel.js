/*
 * "Ask Claude" side panel. Claude only ever returns a proposal. Nothing touches the map until
 * the person clicks Apply, and Apply goes through the normal editing path (one undo step).
 */
(function () {
  'use strict';
  const { h, icon, toast } = window.IdeaUI;

  const SUGGESTIONS = [
    ['Brainstorm here', 'Brainstorm six specific, non-obvious ideas under the selected idea (or under the central idea if nothing is selected).'],
    ['Group by theme', 'Group the existing ideas into clear themes, give each theme its own colour, and tidy the layout.'],
    ['Tighten wording', 'Rewrite any idea that is vague or too long so it is short and concrete. Keep the meaning.'],
    ['What is missing?', 'Look at this map and tell me what is missing. Add the most valuable gaps as new ideas.'],
  ];

  function create({ mapId, api, enabled, isAdmin, getSelected, apply }) {
    const history = []; // { role, content } for earlier turns
    let busy = false;
    let openCard = null; // the one proposal that can still be applied

    const log = h('div', { class: 'ai-log', role: 'log', 'aria-live': 'polite' });
    const input = h('textarea', { class: 'input ai-input', rows: '2', maxlength: '2000', placeholder: 'Ask Claude, e.g. “Add 6 LinkedIn post ideas under Channels”', 'aria-label': 'Message to Claude' });
    const send = h('button', { class: 'btn primary', type: 'button' }, 'Send');
    const chips = h('div', { class: 'ai-chips' }, SUGGESTIONS.map(([label, text]) => h('button', { class: 'btn sm', type: 'button', onclick: () => submit(text) }, label)));
    const newChat = h('button', { class: 'btn ghost sm', type: 'button', title: 'Start a new conversation', onclick: reset }, 'New chat');
    const closeBtn = h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Close Claude panel', onclick: () => panel.classList.add('hidden') }, icon('plus'));
    closeBtn.firstChild.style.transform = 'rotate(45deg)';

    const off = h('div', { class: 'ai-off' },
      h('strong', {}, 'Claude is not switched on yet.'),
      h('p', {}, isAdmin
        ? 'Add ANTHROPIC_API_KEY to the server settings file and restart the app. The README has the steps. Then use “Test connection” on the People page.'
        : 'An admin needs to add the Claude API key to the server settings first.'));

    const body = enabled
      ? [log, chips, h('div', { class: 'ai-compose' }, input, h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, 'Ideas on this map are sent to Claude to answer you. Claude only suggests: you decide what to apply.'), send))]
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
      bubble('assistant', 'Hi! Tell me what to add or change on this map. Select an idea first and I will work on that one. I will show you my proposal before anything changes.');
    }

    function proposal(result) {
      const list = h('ul', { class: 'ai-changes' });
      const shown = result.changes.slice(0, 14);
      for (const c of shown) list.appendChild(h('li', { class: 'k-' + c.kind }, c.label));
      if (result.changes.length > shown.length) list.appendChild(h('li', { class: 'muted' }, `…and ${result.changes.length - shown.length} more`));
      const status = h('span', { class: 'small muted grow' }, result.changes.length + (result.changes.length === 1 ? ' change' : ' changes') + (result.skipped ? ` · ${result.skipped} suggestion${result.skipped === 1 ? '' : 's'} skipped (they did not fit the map)` : ''));
      const applyBtn = h('button', { class: 'btn primary sm', type: 'button' }, 'Apply');
      const dismissBtn = h('button', { class: 'btn sm', type: 'button' }, 'Dismiss');
      const card = h('div', { class: 'ai-card' }, h('strong', {}, 'Proposed changes'), list, h('div', { class: 'row' }, status, dismissBtn, applyBtn));
      const finish = (text) => {
        applyBtn.remove();
        dismissBtn.remove();
        status.textContent = text;
      };
      const entry = { finish };
      applyBtn.addEventListener('click', () => {
        if (apply(result.ops)) {
          finish('Applied. Press Ctrl+Z to undo all of it.');
          if (openCard === entry) openCard = null;
        } else {
          finish('Could not apply (the map changed). Ask again.');
        }
      });
      dismissBtn.addEventListener('click', () => {
        finish('Dismissed');
        if (openCard === entry) openCard = null;
      });
      openCard = entry;
      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
    }

    async function submit(text) {
      const message = (text || input.value).trim();
      if (!message || busy) return;
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
        if (r.ops && r.changes.length) proposal(r);
      } catch (e) {
        wait.remove();
        bubble('assistant error', e.message);
        if (e.status && e.status !== 409) toast(e.message, { error: true });
      } finally {
        busy = false;
        send.disabled = false;
        input.focus();
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
    return {
      el: panel,
      close() {
        panel.classList.add('hidden');
      },
      toggle() {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden') && enabled) input.focus();
      },
    };
  }

  window.IdeaAiPanel = { create };
})();
