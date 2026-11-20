/*
 * Team chat panel. Rooms: "team" and, inside a map, "map-<id>". Messages are sent and loaded over the normal API;
 * a WebSocket (/ws/chat) pushes new messages, deletions, who is online and who is typing. All text is shown with
 * textContent, never as HTML. Only http(s) links become links.
 */
(function () {
  'use strict';
  const { h, icon, avatar, toast } = window.IdeaUI;
  const first = (name) => String(name || '').split(/\s+/)[0].toLowerCase();

  function create({ user, api, rooms: roomList, floating, onOpen }) {
    const rooms = new Map(roomList.map((r) => [r.id, { id: r.id, label: r.label, messages: [], seen: new Set(), loaded: false, hasMore: false, unread: 0, online: [], typing: new Map(), draft: '' }]));
    let active = roomList[0].id;
    let isOpen = false;
    let members = [];
    let ws = null;
    let destroyed = false;
    let retry = 0;
    let reconnectTimer = null;
    let readTimer = null;
    let typingSentAt = 0;
    let unreadWatchers = [];
    let sending = false;

    /* ---------- DOM ---------- */
    const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
    const presence = h('div', { class: 'chat-presence' });
    const typingLine = h('div', { class: 'chat-typing', 'aria-live': 'polite' });
    const input = h('textarea', { class: 'input chat-input', rows: '1', maxlength: '2000', placeholder: 'Write a message…', 'aria-label': 'Message' });
    const sendBtn = h('button', { class: 'btn primary icon', type: 'button', 'aria-label': 'Send message', title: 'Send (Enter)' }, icon('send'));
    const tabBadges = new Map();
    const tabs = roomList.length > 1 ? h('div', { class: 'chat-tabs', role: 'tablist' }, roomList.map((r) => {
      const badge = h('span', { class: 'badge-dot hidden' });
      tabBadges.set(r.id, badge);
      return h('button', { class: 'chat-tab', type: 'button', role: 'tab', 'aria-selected': r.id === active ? 'true' : 'false', dataset: { room: r.id }, onclick: () => switchTo(r.id) }, r.label, badge);
    })) : null;
    const closeBtn = h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Close chat', onclick: () => api2.close() }, icon('plus'));
    closeBtn.firstChild.style.transform = 'rotate(45deg)';
    const title = h('strong', {}, roomList.length > 1 ? 'Chat' : 'Team chat');
    const panel = h('aside', { class: 'chat-panel' + (floating ? ' floating' : '') + ' hidden', 'aria-label': 'Team chat' },
      h('div', { class: 'chat-head' }, title, h('span', { class: 'grow' }), closeBtn),
      tabs, presence, log, typingLine,
      h('div', { class: 'chat-compose' }, input, sendBtn));
    const fabBadge = h('span', { class: 'badge-count hidden' });
    const fab = floating ? h('button', { class: 'chat-fab btn primary', type: 'button', 'aria-label': 'Open team chat', onclick: () => api2.toggle() }, icon('chat'), 'Chat', fabBadge) : null;

    /* ---------- helpers ---------- */
    const cur = () => rooms.get(active);
    const totalUnread = () => Array.from(rooms.values()).reduce((a, r) => a + r.unread, 0);
    const visible = () => isOpen && document.visibilityState === 'visible';

    function paintBadges() {
      const t = totalUnread();
      for (const [id, b] of tabBadges) {
        const r = rooms.get(id);
        b.textContent = r.unread > 99 ? '99+' : String(r.unread);
        b.classList.toggle('hidden', !r.unread);
      }
      if (fab) {
        fabBadge.textContent = t > 99 ? '99+' : String(t);
        fabBadge.classList.toggle('hidden', !t);
        fab.setAttribute('aria-label', t ? `Open team chat, ${t} unread` : 'Open team chat');
      }
      for (const fn of unreadWatchers) fn(t);
    }

    function mine(m) { return m.userId === user.id; }

    function rich(text) {
      const out = [];
      const re = /(https?:\/\/[^\s<>"']+)|(@[\p{L}\p{N}_.-]+)/giu;
      let last = 0;
      let mentionsMe = false;
      let m;
      while ((m = re.exec(text))) {
        if (m.index > last) out.push(text.slice(last, m.index));
        if (m[1]) {
          let url = m[1];
          let trail = '';
          while (/[.,;:!?)\]}]$/.test(url)) { trail = url.slice(-1) + trail; url = url.slice(0, -1); }
          let ok = false;
          try { const u = new URL(url); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch { /* not a URL */ }
          out.push(ok ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow' }, url) : url);
          if (trail) out.push(trail);
        } else {
          const name = m[2].slice(1).toLowerCase().replace(/[.-]+$/, '');
          const hit = members.find((x) => first(x.name) === name || x.name.toLowerCase().replace(/\s+/g, '') === name);
          if (hit && hit.id === user.id) mentionsMe = true;
          out.push(hit ? h('span', { class: 'mention' + (hit.id === user.id ? ' me' : '') }, m[2]) : m[2]);
        }
        last = re.lastIndex;
      }
      if (last < text.length) out.push(text.slice(last));
      return { nodes: out, mentionsMe };
    }

    const dayLabel = (ts) => {
      const d = new Date(ts);
      const today = new Date();
      const yest = new Date(today.getTime() - 86400000);
      const same = (a, b) => a.toDateString() === b.toDateString();
      if (same(d, today)) return 'Today';
      if (same(d, yest)) return 'Yesterday';
      return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    };

    function messageEl(m, continued) {
      const { nodes, mentionsMe } = rich(m.text);
      const canDelete = mine(m) || user.role === 'admin';
      const time = new Date(m.createdAt);
      return h('div', { class: 'chat-msg' + (mine(m) ? ' mine' : '') + (mentionsMe && !mine(m) ? ' mentions-me' : '') + (continued ? ' cont' : ''), dataset: { id: String(m.id) } },
        continued ? h('span', { class: 'chat-gutter' }) : avatar({ name: m.name, color: m.color }),
        h('div', { class: 'chat-body' },
          continued ? null : h('div', { class: 'chat-meta' }, h('strong', {}, m.name), h('time', { datetime: time.toISOString(), title: time.toLocaleString() }, time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))),
          h('div', { class: 'chat-text' }, nodes)),
        canDelete ? h('button', { class: 'chat-del', type: 'button', 'aria-label': 'Delete message', title: 'Delete message', onclick: () => remove(m) }, '✕') : null);
    }

    function render({ keepOffset } = {}) {
      const r = cur();
      if (!r) return;
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      const prevHeight = log.scrollHeight;
      const kids = [];
      if (r.hasMore) kids.push(h('button', { class: 'btn sm chat-more', type: 'button', onclick: loadOlder }, 'Load earlier messages'));
      if (r.loaded && !r.messages.length) kids.push(h('div', { class: 'chat-empty' }, active === 'team' ? 'No messages yet. Say hello to your team.' : 'No messages about this map yet. Start the discussion here.'));
      let prev = null;
      for (const m of r.messages) {
        const sameDay = prev && new Date(prev.createdAt).toDateString() === new Date(m.createdAt).toDateString();
        if (!sameDay) kids.push(h('div', { class: 'chat-day' }, h('span', {}, dayLabel(m.createdAt))));
        const continued = !!(prev && sameDay && prev.userId === m.userId && m.createdAt - prev.createdAt < 5 * 60 * 1000);
        kids.push(messageEl(m, continued));
        prev = m;
      }
      log.replaceChildren(...kids);
      if (keepOffset) log.scrollTop = log.scrollHeight - prevHeight;
      else if (nearBottom || !r.loaded) log.scrollTop = log.scrollHeight;
    }

    function renderPresence() {
      const r = cur();
      if (!r) return;
      const others = r.online.filter((u) => u.id !== user.id);
      presence.replaceChildren(
        ...r.online.slice(0, 6).map((u) => avatar(u, u.id === user.id ? 'You' : u.name)),
        h('span', { class: 'small muted' }, !others.length ? 'Only you are online right now' : others.length === 1 ? `${others[0].name} is online` : `${r.online.length} people online`));
    }

    function renderTyping() {
      const r = cur();
      if (!r) return;
      const now = Date.now();
      for (const [id, t] of r.typing) if (t.until < now) r.typing.delete(id);
      const names = Array.from(r.typing.values()).map((t) => t.name);
      typingLine.textContent = !names.length ? '' : names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
    }

    function addMessage(roomId, m) {
      const r = rooms.get(roomId);
      if (!r || r.seen.has(m.id)) return false;
      r.seen.add(m.id);
      const i = r.messages.findIndex((x) => x.id > m.id);
      if (i < 0) r.messages.push(m);
      else r.messages.splice(i, 0, m);
      return true;
    }

    /* ---------- reading ---------- */
    function markRead(roomId) {
      const r = rooms.get(roomId || active);
      if (!r || !r.messages.length) return;
      r.unread = 0;
      paintBadges();
      clearTimeout(readTimer);
      readTimer = setTimeout(() => {
        const last = r.messages[r.messages.length - 1];
        if (last) api('POST', `/api/chat/rooms/${r.id}/read`, { lastId: last.id }).catch(() => {});
      }, 300);
    }

    async function ensureLoaded(roomId) {
      const r = rooms.get(roomId);
      if (!r || r.loaded) return;
      try {
        const res = await api('GET', `/api/chat/rooms/${r.id}/messages`);
        for (const m of res.messages) addMessage(r.id, m);
        r.loaded = true;
        r.hasMore = res.hasMore;
        if (active === r.id) render();
        if (visible() && active === r.id) markRead();
      } catch (e) {
        if (e.status === 404) return roomGone(r.id);
        toast(e.message, { error: true });
      }
    }

    async function loadOlder() {
      const r = cur();
      if (!r || !r.messages.length) return;
      try {
        const res = await api('GET', `/api/chat/rooms/${r.id}/messages?before=${r.messages[0].id}`);
        for (const m of res.messages) addMessage(r.id, m);
        r.hasMore = res.hasMore;
        render({ keepOffset: true });
      } catch (e) { toast(e.message, { error: true }); }
    }

    async function catchUp() {
      for (const r of rooms.values()) {
        if (!r.loaded || !r.messages.length) continue;
        try {
          const res = await api('GET', `/api/chat/rooms/${r.id}/messages?after=${r.messages[r.messages.length - 1].id}`);
          let added = 0;
          for (const m of res.messages) if (addMessage(r.id, m)) { added++; if (!mine(m) && !(visible() && active === r.id)) r.unread++; }
          if (added && active === r.id) render();
        } catch { /* try again on the next reconnect */ }
      }
      paintBadges();
    }

    async function refreshUnread() {
      try {
        const { unread } = await api('GET', '/api/chat/unread');
        for (const r of rooms.values()) r.unread = visible() && active === r.id ? 0 : unread[r.id] || 0;
        paintBadges();
      } catch { /* not critical */ }
    }

    /* ---------- actions ---------- */
    function switchTo(id) {
      if (!rooms.has(id)) return;
      const from = cur(); // gone when the room it showed was just deleted
      if (from) from.draft = input.value;
      active = id;
      input.value = cur().draft;
      for (const b of panel.querySelectorAll('.chat-tab')) b.setAttribute('aria-selected', b.dataset.room === id ? 'true' : 'false');
      render();
      renderPresence();
      renderTyping();
      ensureLoaded(id);
      if (visible()) markRead();
      input.focus();
    }

    async function send() {
      const text = input.value.trim();
      const r = cur();
      if (!text || sending || !r) return;
      sending = true;
      sendBtn.disabled = true;
      try {
        const res = await api('POST', `/api/chat/rooms/${r.id}/messages`, { text });
        input.value = '';
        r.draft = '';
        autosize();
        if (addMessage(r.id, res.message)) render();
        log.scrollTop = log.scrollHeight;
        markRead();
      } catch (e) {
        toast(e.message, { error: true });
      } finally {
        sending = false;
        sendBtn.disabled = false;
        input.focus();
      }
    }

    async function remove(m) {
      try {
        await api('DELETE', `/api/chat/messages/${m.id}`);
        dropMessage(m.room, m.id);
      } catch (e) { toast(e.message, { error: true }); }
    }

    function dropMessage(roomId, id) {
      const r = rooms.get(roomId);
      if (!r) return;
      const i = r.messages.findIndex((x) => x.id === id);
      if (i >= 0) r.messages.splice(i, 1);
      if (active === roomId) render();
    }

    function roomGone(id) {
      const r = rooms.get(id);
      if (!r) return;
      rooms.delete(id);
      const tab = panel.querySelector(`.chat-tab[data-room="${CSS.escape(id)}"]`);
      if (tab) tab.remove();
      tabBadges.delete(id);
      if (active === id) {
        const next = rooms.keys().next().value;
        if (next) switchTo(next);
      }
      paintBadges();
    }

    function autosize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 130) + 'px';
    }

    /* ---------- socket ---------- */
    function connect() {
      if (destroyed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${proto}//${location.host}/ws/chat`);
      ws = sock;
      sock.onopen = () => {
        if (sock !== ws) return;
        sock.send(JSON.stringify({ t: 'sub', rooms: Array.from(rooms.keys()) }));
        if (retry > 0) catchUp();
        retry = 0;
      };
      sock.onmessage = (e) => {
        if (sock !== ws) return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        onPush(m);
      };
      sock.onclose = (e) => {
        if (sock !== ws || destroyed) return;
        if (e.code === 4401) return; // signed out: the app handles it
        reconnectTimer = setTimeout(connect, Math.min(15000, 500 * Math.pow(2, retry++)));
      };
    }

    function onPush(m) {
      if (m.t === 'msg') {
        const r = rooms.get(m.room);
        if (!r) return;
        r.typing.delete(m.message.userId);
        if (!r.loaded) {
          // not opened yet: just count it. The history is fetched when the room is first opened.
          if (!mine(m.message)) { r.unread++; paintBadges(); }
          return;
        }
        if (!addMessage(m.room, m.message)) return;
        if (active === m.room) { render(); renderTyping(); }
        if (!mine(m.message)) {
          if (visible() && active === m.room) markRead();
          else { r.unread++; paintBadges(); }
        }
      } else if (m.t === 'del') {
        dropMessage(m.room, m.id);
        refreshUnread();
      } else if (m.t === 'presence') {
        const r = rooms.get(m.room);
        if (r) { r.online = m.users; if (active === m.room) renderPresence(); }
      } else if (m.t === 'typing') {
        const r = rooms.get(m.room);
        if (!r || m.user.id === user.id) return;
        r.typing.set(m.user.id, { name: m.user.name, until: Date.now() + 3500 });
        if (active === m.room) renderTyping();
        setTimeout(() => { if (!destroyed && active === m.room) renderTyping(); }, 3700);
      } else if (m.t === 'gone') roomGone(m.room);
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('input', () => {
      autosize();
      const here = cur();
      if (here) here.draft = input.value;
      const now = Date.now();
      if (input.value.trim() && ws && ws.readyState === 1 && now - typingSentAt > 2000) {
        typingSentAt = now;
        ws.send(JSON.stringify({ t: 'typing', room: active }));
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
      e.stopPropagation(); // typing here must never trigger editor shortcuts
    });
    const onVisible = () => { if (visible()) markRead(); };
    document.addEventListener('visibilitychange', onVisible);

    /* ---------- public ---------- */
    const api2 = {
      el: panel,
      fab,
      isOpen: () => isOpen,
      totalUnread,
      onUnread(fn) { unreadWatchers.push(fn); fn(totalUnread()); },
      open() {
        if (onOpen) onOpen();
        isOpen = true;
        panel.classList.remove('hidden');
        if (fab) fab.classList.add('hidden');
        render();
        renderPresence();
        ensureLoaded(active).then(() => { if (visible()) markRead(); });
        if (cur().loaded && visible()) markRead();
        input.focus();
      },
      close() {
        isOpen = false;
        panel.classList.add('hidden');
        if (fab) fab.classList.remove('hidden');
      },
      toggle() { if (isOpen) api2.close(); else api2.open(); },
      destroy() {
        destroyed = true;
        clearTimeout(reconnectTimer);
        clearTimeout(readTimer);
        document.removeEventListener('visibilitychange', onVisible);
        if (ws) ws.close();
        panel.remove();
        if (fab) fab.remove();
      },
    };

    api('GET', '/api/chat/members').then((r) => { members = r.members; if (isOpen) render(); }).catch(() => {});
    refreshUnread();
    connect();
    return api2;
  }

  window.IdeaChat = { create };
})();
