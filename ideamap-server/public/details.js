/*
 * Details panel: the description and the comment thread of the selected idea.
 * The description is part of the map (an operation, so it is live for everyone and undoable). Editors write it,
 * everyone can read it. Comments are a conversation: everyone signed in can write, viewers included.
 * All text is shown with textContent, never as HTML.
 */
(function () {
  'use strict';
  const { h, icon, avatar, toast, relTime, richText } = window.IdeaUI;
  const MAX_NOTE = 2000;

  function create({ mapId, user, api, canEdit, getIdea, setNote, onOpen }) {
    let nodeId = null;
    let isOpen = false;
    let members = [];
    let comments = [];
    let seq = 0;
    let sending = false;

    const title = h('div', { class: 'dt-title' });
    const noteBox = h('textarea', { class: 'input dt-note', rows: '5', maxlength: String(MAX_NOTE), placeholder: 'Describe this idea: the goal, details, links, next steps…', 'aria-label': 'Description' });
    const noteView = h('div', { class: 'dt-note-view' });
    const noteCount = h('span', { class: 'small muted' });
    const list = h('div', { class: 'dt-comments', role: 'log', 'aria-live': 'polite', 'aria-label': 'Comments' });
    const heading = h('h3', {}, 'Comments');
    const box = h('textarea', { class: 'input dt-compose', rows: '2', maxlength: '2000', placeholder: 'Write a comment…', 'aria-label': 'Comment' });
    const sendBtn = h('button', { class: 'btn primary icon', type: 'button', 'aria-label': 'Post comment', title: 'Post (Enter)' }, icon('send'));
    const body = h('div', { class: 'dt-body' });
    const empty = h('div', { class: 'dt-empty' }, 'Select an idea to see its description and comments.');
    const closeBtn = h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Close details', onclick: () => api2.close() }, icon('plus'));
    closeBtn.firstChild.style.transform = 'rotate(45deg)';
    const panel = h('aside', { class: 'details-panel hidden', 'aria-label': 'Idea details' },
      h('div', { class: 'dt-head' }, h('strong', {}, 'Details'), h('span', { class: 'grow' }), closeBtn), empty, body);

    // Both layouts exist; which one shows depends on the role at the moment (the role arrives from the server after this panel is built).
    const noteRow = h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, 'Saved for everyone when you click away.'), noteCount);
    const applyMode = () => {
      const edit = canEdit();
      noteBox.classList.toggle('hidden', !edit);
      noteRow.classList.toggle('hidden', !edit);
      noteView.classList.toggle('hidden', edit);
    };
    body.append(
      title,
      h('div', { class: 'dt-section' }, h('h3', {}, 'Description'), noteBox, noteView, noteRow),
      h('div', { class: 'dt-section dt-thread' }, heading, list));
    const composer = h('div', { class: 'dt-composer hidden' }, box, sendBtn); // pinned below the scrolling part
    panel.appendChild(composer);

    /* ---------- description ---------- */
    const idea = () => (nodeId ? getIdea(nodeId) : null);
    const savedNote = () => (idea() && idea().note) || '';

    function paintNote() {
      const n = idea();
      if (!n) return;
      if (canEdit()) {
        if (document.activeElement !== noteBox) noteBox.value = savedNote();
        noteCount.textContent = `${noteBox.value.length}/${MAX_NOTE}`;
        noteCount.classList.toggle('over', noteBox.value.length > MAX_NOTE - 100);
      } else {
        const t = savedNote();
        noteView.replaceChildren(...(t ? richText(t, members, user.id).nodes : [h('span', { class: 'muted' }, 'No description yet.')]));
        noteView.classList.toggle('none', !t);
      }
    }

    function flushNote() {
      if (!canEdit() || !nodeId || !idea()) return;
      const text = noteBox.value.replace(/\s+$/, '');
      if (text === savedNote()) return;
      if (!setNote(nodeId, text)) noteBox.value = savedNote(); // refused (view-only, disconnected, too long)
    }

    noteBox.addEventListener('blur', flushNote);
    noteBox.addEventListener('input', () => {
      noteCount.textContent = `${noteBox.value.length}/${MAX_NOTE}`;
      noteCount.classList.toggle('over', noteBox.value.length > MAX_NOTE - 100);
    });
    noteBox.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        noteBox.value = savedNote();
        noteBox.blur();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        noteBox.blur();
      }
      e.stopPropagation(); // typing here must never trigger board shortcuts
    });

    /* ---------- comments ---------- */
    function paintComments() {
      heading.textContent = comments.length ? `Comments (${comments.length})` : 'Comments';
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      if (!comments.length) {
        list.replaceChildren(h('div', { class: 'dt-none' }, 'No comments yet. Start the conversation.'));
        return;
      }
      list.replaceChildren(...comments.map((c) => {
        const { nodes, mentionsMe } = richText(c.text, members, user.id);
        const canDelete = c.userId === user.id || user.role === 'admin';
        const time = new Date(c.createdAt);
        return h('div', { class: 'dt-comment' + (mentionsMe && c.userId !== user.id ? ' mentions-me' : ''), dataset: { id: String(c.id) } },
          avatar({ name: c.name, color: c.color }),
          h('div', { class: 'dt-cbody' },
            h('div', { class: 'chat-meta' }, h('strong', {}, c.name), h('time', { datetime: time.toISOString(), title: time.toLocaleString() }, relTime(c.createdAt))),
            h('div', { class: 'chat-text' }, nodes)),
          canDelete ? h('button', { class: 'chat-del', type: 'button', 'aria-label': 'Delete comment', title: 'Delete comment', onclick: () => remove(c) }, '✕') : null);
      }));
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }

    async function loadComments() {
      const mine = ++seq;
      const id = nodeId;
      comments = [];
      list.replaceChildren(h('div', { class: 'dt-none' }, 'Loading…'));
      try {
        const r = await api('GET', `/api/maps/${encodeURIComponent(mapId)}/nodes/${encodeURIComponent(id)}/comments`);
        if (mine !== seq) return;
        comments = r.comments;
        paintComments();
        list.scrollTop = list.scrollHeight;
      } catch (e) {
        if (mine !== seq) return;
        list.replaceChildren(h('div', { class: 'dt-none' }, e.status === 404 ? 'This idea no longer exists.' : e.message));
      }
    }

    async function post() {
      const text = box.value.trim();
      if (!text || sending || !nodeId) return;
      sending = true;
      sendBtn.disabled = true;
      try {
        const r = await api('POST', `/api/maps/${encodeURIComponent(mapId)}/nodes/${encodeURIComponent(nodeId)}/comments`, { text });
        box.value = '';
        if (!comments.some((c) => c.id === r.comment.id)) comments.push(r.comment);
        paintComments();
        list.scrollTop = list.scrollHeight;
      } catch (e) {
        toast(e.message, { error: true });
      } finally {
        sending = false;
        sendBtn.disabled = false;
        box.focus();
      }
    }

    async function remove(c) {
      try {
        await api('DELETE', `/api/comments/${c.id}`);
        comments = comments.filter((x) => x.id !== c.id);
        paintComments();
      } catch (e) { toast(e.message, { error: true }); }
    }

    sendBtn.addEventListener('click', post);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        post();
      }
      e.stopPropagation();
    });

    /* ---------- showing an idea ---------- */
    function show(id) {
      if (id !== nodeId) flushNote(); // keep what was typed for the previous idea
      const n = id ? getIdea(id) : null;
      nodeId = n ? id : null;
      empty.classList.toggle('hidden', !!n);
      body.classList.toggle('hidden', !n);
      composer.classList.toggle('hidden', !n);
      if (!n) return;
      title.textContent = n.text || 'New idea';
      applyMode();
      noteBox.value = savedNote();
      paintNote();
      loadComments();
    }

    const api2 = {
      el: panel,
      isOpen: () => isOpen,
      open(id) {
        if (onOpen) onOpen();
        isOpen = true;
        panel.classList.remove('hidden');
        show(id || null);
        if (canEdit() && nodeId) noteBox.focus();
        else if (nodeId) box.focus();
      },
      close() {
        if (!isOpen) return;
        flushNote();
        isOpen = false;
        panel.classList.add('hidden');
      },
      toggle(id) { if (isOpen) api2.close(); else api2.open(id); },
      // called when the selection changes while the panel is open
      follow(id) { if (isOpen) show(id); },
      // called after the map changes: refresh the title and (if not being edited) the description
      refresh() {
        if (!isOpen || !nodeId) return;
        const n = getIdea(nodeId);
        if (!n) { show(null); return; }
        title.textContent = n.text || 'New idea';
        applyMode();
        paintNote();
      },
      // live comment pushes from the map socket
      onPush(m) {
        if (!isOpen || m.nodeId !== nodeId) return;
        if (m.t === 'comment') {
          if (!comments.some((c) => c.id === m.comment.id)) comments.push(m.comment);
        } else if (m.t === 'comment-del') comments = comments.filter((c) => c.id !== m.id);
        paintComments();
      },
    };

    api('GET', '/api/chat/members').then((r) => { members = r.members; if (isOpen) { paintNote(); paintComments(); } }).catch(() => {});
    show(null);
    return api2;
  }

  window.IdeaDetails = { create };
})();
