(function () {
  'use strict';
  const { h, icon, logo, avatar, toast, modal, relTime, download } = window.IdeaUI;
  const root = document.getElementById('app');
  const state = { user: null, csrf: null, needsSetup: false, setupTokenRequired: false, ai: { enabled: false } };
  let editor = null;

  /* ---------- API ---------- */
  async function api(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: { 'x-idea-map': '1' } };
    if (method !== 'GET') {
      opts.headers['content-type'] = 'application/json';
      if (state.csrf) opts.headers['x-csrf-token'] = state.csrf;
      opts.body = JSON.stringify(body || {});
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch {
      throw Object.assign(new Error('Cannot reach the server. Check your connection.'), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && state.user && url !== '/api/login') {
        state.user = null;
        state.csrf = null;
        setTimeout(route, 0);
      }
      throw Object.assign(new Error((data && data.error) || 'Something went wrong (' + res.status + ')'), { status: res.status });
    }
    return data;
  }

  function navigate(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function signedOut() {
    state.user = null;
    state.csrf = null;
    route();
  }

  /* ---------- routing ---------- */
  function route() {
    if (editor) {
      editor.destroy();
      editor = null;
    }
    document.title = 'Idea Map';
    const hash = location.hash || '#/';
    let m;
    if ((m = hash.match(/^#\/invite\/([A-Za-z0-9_-]+)$/))) return viewInvite(m[1]);
    if (state.needsSetup) return viewSetup();
    if (!state.user) return viewLogin();
    if ((m = hash.match(/^#\/map\/([A-Za-z0-9_-]+)$/))) return viewMap(m[1]);
    if (hash === '#/admin') return state.user.role === 'admin' ? viewAdmin() : navigate('#/');
    return viewLibrary();
  }

  async function boot() {
    try {
      const s = await api('GET', '/api/session');
      state.user = s.user;
      state.csrf = s.csrf;
      state.needsSetup = s.needsSetup;
      state.setupTokenRequired = s.setupTokenRequired;
      state.ai = s.ai || { enabled: false };
    } catch (e) {
      root.replaceChildren(h('div', { class: 'center-wrap' }, h('div', { class: 'card auth-card' }, h('h1', {}, 'Idea Map'), h('p', { class: 'error', role: 'alert' }, e.message))));
      return;
    }
    route();
  }
  window.addEventListener('hashchange', route);

  /* ---------- shared pieces ---------- */
  const ROLE_HELP = { admin: 'Admin: everything, plus people and invites', editor: 'Editor: create and edit maps', viewer: 'Viewer: read-only' };

  function field(label, input) {
    return h('label', { class: 'field' }, h('span', {}, label), input);
  }

  function authCard(children) {
    return h('main', { class: 'center-wrap', id: 'main' },
      h('div', {}, h('div', { class: 'card auth-card' }, h('div', { class: 'brand' }, logo(), 'Idea Map'), children),
        h('p', { class: 'footer' }, 'Idea Map by Aligned')));
  }

  function formError() {
    return h('div', { class: 'error', role: 'alert' });
  }

  // Runs fn while the submit button is disabled and shows any error under the form.
  function submitter(form, errBox, fn) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = form.querySelector('button[type=submit]');
      errBox.textContent = '';
      b.disabled = true;
      try {
        await fn();
      } catch (err) {
        errBox.textContent = err.message;
      } finally {
        b.disabled = false;
      }
    });
  }

  function topbar() {
    const u = state.user;
    const menuBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, avatar(u), h('span', {}, u.name));
    const wrap = h('div', { class: 'menu-wrap' }, menuBtn);
    let menu = null;
    const close = () => {
      if (menu) menu.remove();
      menu = null;
      menuBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', esc, true);
    };
    const outside = (e) => { if (!wrap.contains(e.target)) close(); };
    const esc = (e) => { if (e.key === 'Escape') { close(); menuBtn.focus(); } };
    menuBtn.addEventListener('click', () => {
      if (menu) return close();
      menu = h('div', { class: 'menu', role: 'menu' },
        h('div', { class: 'who' }, h('strong', {}, u.name), h('div', { class: 'small muted' }, u.email), h('span', { class: 'badge ' + u.role }, u.role)),
        h('button', { role: 'menuitem', type: 'button', onclick: () => { const t = window.IdeaTheme.toggle(); toast('Switched to ' + t + ' theme'); close(); } },
          icon(window.IdeaTheme.current() === 'dark' ? 'sun' : 'moon'), window.IdeaTheme.current() === 'dark' ? 'Light theme' : 'Dark theme'),
        h('button', { role: 'menuitem', type: 'button', onclick: () => { close(); changePassword(); } }, icon('key'), 'Change password'),
        h('button', { role: 'menuitem', type: 'button', onclick: async () => { try { await api('POST', '/api/logout'); } catch { /* already out */ } signedOut(); } }, icon('logout'), 'Sign out'));
      wrap.appendChild(menu);
      menuBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', esc, true);
      menu.querySelector('button').focus();
    });
    return h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#/' }, logo(), 'Idea Map', h('small', {}, 'by Aligned')),
      h('span', { class: 'grow' }),
      u.role === 'admin' ? h('a', { class: 'btn ghost', href: '#/admin' }, icon('users'), 'People') : null,
      wrap);
  }

  function changePassword() {
    const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const nw = h('input', { type: 'password', autocomplete: 'new-password', minlength: '10', required: true });
    const nw2 = h('input', { type: 'password', autocomplete: 'new-password', minlength: '10', required: true });
    const err = formError();
    modal({
      title: 'Change password',
      content: h('div', { class: 'stack' }, field('Current password', cur), field('New password (10+ characters)', nw), field('Repeat new password', nw2), err),
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Change password', primary: true,
          onClick: async () => {
            err.textContent = '';
            if (nw.value !== nw2.value) { err.textContent = 'The new passwords do not match.'; return false; }
            try {
              await api('POST', '/api/me/password', { current: cur.value, next: nw.value });
              toast('Password changed. Other devices were signed out.');
            } catch (e) {
              err.textContent = e.message;
              return false;
            }
          },
        },
      ],
    });
  }

  /* ---------- auth views ---------- */
  function viewSetup() {
    const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '80' });
    const email = h('input', { type: 'email', autocomplete: 'email', required: true });
    const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: '10', required: true });
    const token = state.setupTokenRequired ? h('input', { type: 'password', autocomplete: 'off', required: true }) : null;
    const err = formError();
    const form = h('form', { class: 'stack' },
      field('Your name', name), field('Email', email), field('Password (10+ characters)', pw),
      token ? field('Setup token (from the server settings)', token) : null,
      err, h('button', { class: 'btn primary', type: 'submit' }, 'Create admin account'));
    submitter(form, err, async () => {
      const r = await api('POST', '/api/setup', { name: name.value, email: email.value, password: pw.value, setupToken: token ? token.value : undefined });
      state.user = r.user;
      state.csrf = r.csrf;
      state.needsSetup = false;
      navigate('#/');
    });
    root.replaceChildren(authCard([h('h1', {}, 'Welcome'), h('p', { class: 'muted' }, 'You are the first person here, so you will be the admin. You can invite your team afterwards.'), form]));
    name.focus();
  }

  function viewLogin() {
    const email = h('input', { type: 'email', autocomplete: 'username', required: true });
    const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
    const err = formError();
    const form = h('form', { class: 'stack' }, field('Email', email), field('Password', pw), err, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
    submitter(form, err, async () => {
      const r = await api('POST', '/api/login', { email: email.value, password: pw.value });
      state.user = r.user;
      state.csrf = r.csrf;
      navigate(location.hash.startsWith('#/map/') ? location.hash : '#/');
    });
    root.replaceChildren(authCard([h('h1', {}, 'Sign in'), h('p', { class: 'muted' }, 'Brainstorm marketing ideas together, live.'), form, h('p', { class: 'small muted' }, 'No account? Ask an admin for an invite link.')]));
    email.focus();
  }

  async function viewInvite(token) {
    root.replaceChildren(authCard([h('p', { class: 'muted' }, 'Checking your invite…')]));
    let info;
    try {
      info = await api('GET', '/api/invites/' + encodeURIComponent(token));
    } catch (e) {
      root.replaceChildren(authCard([h('h1', {}, 'Invite not valid'), h('p', { class: 'error', role: 'alert' }, e.message), h('p', {}, h('a', { href: '#/' }, 'Go to sign in'))]));
      return;
    }
    const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '80' });
    const email = h('input', { type: 'email', autocomplete: 'email', required: true });
    const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: '10', required: true });
    const err = formError();
    const form = h('form', { class: 'stack' }, field('Your name', name), field('Email', email), field('Choose a password (10+ characters)', pw), err, h('button', { class: 'btn primary', type: 'submit' }, 'Join Idea Map'));
    submitter(form, err, async () => {
      const r = await api('POST', '/api/invites/' + encodeURIComponent(token) + '/accept', { name: name.value, email: email.value, password: pw.value });
      state.user = r.user;
      state.csrf = r.csrf;
      state.needsSetup = false;
      history.replaceState(null, '', '#/');
      route();
    });
    root.replaceChildren(authCard([h('h1', {}, 'You are invited'), h('p', { class: 'muted' }, 'You will join as ' + info.role + '. ' + (ROLE_HELP[info.role] || '')), form]));
    name.focus();
  }

  /* ---------- library ---------- */
  function viewLibrary() {
    const u = state.user;
    const canEdit = u.role !== 'viewer';
    const search = h('input', { type: 'search', placeholder: 'Search maps and ideas…', 'aria-label': 'Search maps and ideas', autocomplete: 'off' });
    const list = h('div', { class: 'card list', role: 'list' });
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', class: 'hidden', 'aria-hidden': 'true', tabindex: '-1' });
    let seq = 0;

    async function load() {
      const mine = ++seq;
      try {
        const q = search.value.trim();
        const r = await api('GET', '/api/maps?q=' + encodeURIComponent(q));
        if (mine !== seq) return;
        draw(r.maps, q);
      } catch (e) {
        if (mine === seq) list.replaceChildren(h('div', { class: 'empty error' }, e.message));
      }
    }

    function draw(maps, q) {
      if (!maps.length) {
        list.replaceChildren(q
          ? h('div', { class: 'empty' }, h('h3', {}, 'No matches'), h('p', {}, 'Nothing found for “' + q + '”.'))
          : h('div', { class: 'empty' }, h('h3', {}, 'No maps yet'), h('p', {}, canEdit ? 'Create the first one to start brainstorming.' : 'An editor has not created any maps yet.')));
        return;
      }
      const rows = [h('div', { class: 'list-row list-head', 'aria-hidden': 'true' }, h('span', {}, 'Map'), h('span', {}, 'Owner'), h('span', {}, 'Ideas'), h('span', {}, 'Updated'), h('span', {}))];
      for (const m of maps) {
        const canDelete = u.role === 'admin' || (canEdit && m.ownerId === u.id);
        const small = (label, ic, fn, extra) => h('button', Object.assign({ class: 'btn ghost icon sm', type: 'button', title: label, 'aria-label': label + ': ' + m.title, onclick: fn }, extra || {}), icon(ic));
        rows.push(h('div', { class: 'list-row', role: 'listitem' },
          h('a', { class: 'title', href: '#/map/' + m.id }, m.title),
          h('span', { class: 'col-owner muted' }, m.ownerName || '—'),
          h('span', { class: 'col-count muted' }, String(m.nodeCount)),
          h('span', { class: 'col-when muted' }, relTime(m.updatedAt)),
          h('span', { class: 'actions' },
            canEdit ? small('Rename', 'edit', () => renameMap(m)) : null,
            canEdit ? small('Duplicate', 'copy', () => duplicateMap(m)) : null,
            small('Download JSON', 'download', () => download('/api/maps/' + m.id + '/export', '')),
            canDelete ? small('Delete', 'trash', () => deleteMap(m)) : null)));
      }
      list.replaceChildren(...rows);
    }

    function renameMap(m) {
      const input = h('input', { type: 'text', value: m.title, maxlength: '120', required: true });
      const err = formError();
      modal({
        title: 'Rename map', content: h('div', { class: 'stack' }, field('Title', input), err),
        buttons: [{ label: 'Cancel' }, {
          label: 'Save', primary: true,
          onClick: async () => {
            try { await api('PATCH', '/api/maps/' + m.id, { title: input.value }); load(); } catch (e) { err.textContent = e.message; return false; }
          },
        }],
      });
      input.select();
    }

    async function duplicateMap(m) {
      try {
        const r = await api('POST', '/api/maps/' + m.id + '/duplicate');
        toast('Created “' + r.map.title + '”');
        load();
      } catch (e) { toast(e.message, { error: true }); }
    }

    function deleteMap(m) {
      modal({
        title: 'Delete this map?',
        content: h('p', {}, '“' + m.title + '” will be deleted for everyone. This cannot be undone. You can download a JSON copy first.'),
        buttons: [{ label: 'Cancel' }, {
          label: 'Delete map', danger: true,
          onClick: async () => {
            try { await api('DELETE', '/api/maps/' + m.id); toast('Map deleted'); load(); } catch (e) { toast(e.message, { error: true }); }
          },
        }],
      });
    }

    async function newMap() {
      const { templates } = await api('GET', '/api/templates');
      let chosen = 'blank';
      const title = h('input', { type: 'text', maxlength: '120', placeholder: 'e.g. Q1 webinar ideas' });
      const err = formError();
      const grid = h('div', { class: 'tpl-grid', role: 'radiogroup', 'aria-label': 'Template' });
      const btns = templates.map((t) => {
        const b = h('button', { class: 'tpl', type: 'button', role: 'radio', 'aria-checked': t.id === chosen ? 'true' : 'false' }, h('strong', {}, t.name), h('span', {}, t.description));
        b.addEventListener('click', () => {
          chosen = t.id;
          btns.forEach((x) => x.setAttribute('aria-checked', x === b ? 'true' : 'false'));
        });
        return b;
      });
      grid.append(...btns);
      modal({
        title: 'New map', content: h('div', { class: 'stack' }, field('Title (optional)', title), h('div', { class: 'field' }, h('span', {}, 'Start from'), grid), err),
        buttons: [{ label: 'Cancel' }, {
          label: 'Create map', primary: true,
          onClick: async () => {
            try {
              const r = await api('POST', '/api/maps', { template: chosen, title: title.value.trim() || undefined });
              navigate('#/map/' + r.map.id);
            } catch (e) { err.textContent = e.message; return false; }
          },
        }],
      });
    }

    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      if (f.size > 2.5 * 1024 * 1024) return toast('That file is too large.', { error: true });
      try {
        const data = JSON.parse(await f.text());
        const r = await api('POST', '/api/maps/import', { data });
        toast('Imported “' + r.map.title + '”');
        navigate('#/map/' + r.map.id);
      } catch (e) {
        toast(e instanceof SyntaxError ? 'That file is not valid JSON.' : e.message, { error: true });
      }
    });

    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(load, 220);
    });

    root.replaceChildren(topbar(), h('main', { class: 'page', id: 'main' },
      h('div', { class: 'page-head' },
        h('h1', {}, 'Idea maps'), h('span', { class: 'grow' }),
        h('div', { class: 'search' }, icon('search'), search),
        canEdit ? h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, icon('upload'), 'Import JSON') : null,
        canEdit ? h('button', { class: 'btn primary', type: 'button', onclick: () => newMap().catch((e) => toast(e.message, { error: true })) }, icon('plus'), 'New map') : null,
        fileInput),
      list,
      h('p', { class: 'footer' }, canEdit ? 'Everyone signed in can see every map. Editors and admins can change them.' : 'You have view-only access. Ask an admin if you need to edit.')));
    load();
  }

  /* ---------- editor ---------- */
  function viewMap(id) {
    root.replaceChildren();
    editor = window.IdeaEditor.open(root, id, { api, navigate, onSignedOut: signedOut, ai: state.ai, isAdmin: state.user.role === 'admin' });
  }

  /* ---------- admin ---------- */
  async function viewAdmin() {
    const usersBox = h('div', { class: 'card table-wrap' });
    const claudeBox = h('div', { class: 'card', style: { padding: '16px' } });
    const invitesBox = h('div', { class: 'card table-wrap' });
    const role = h('select', { 'aria-label': 'Role for the new invite' }, ['editor', 'viewer', 'admin'].map((r) => h('option', { value: r }, ROLE_HELP[r])));
    const note = h('input', { type: 'text', maxlength: '80', placeholder: 'Who is this for? (optional, only you see it)', 'aria-label': 'Note' });

    async function drawClaude() {
      try {
        const c = await api('GET', '/api/admin/ai');
        const result = h('p', { class: 'small', role: 'status' });
        const test = h('button', { class: 'btn', type: 'button', disabled: !c.enabled || undefined }, 'Test connection');
        test.addEventListener('click', async () => {
          test.disabled = true;
          result.className = 'small muted';
          result.textContent = 'Asking Claude…';
          try {
            const r = await api('POST', '/api/admin/ai/test');
            result.className = 'small';
            result.textContent = 'Working. Claude (' + r.model + ') answered and proposed ' + r.proposed + ' change.';
          } catch (e) {
            result.className = 'small error';
            result.textContent = e.message;
          } finally { test.disabled = false; }
        });
        claudeBox.replaceChildren(
          h('div', { class: 'row', style: { flexWrap: 'wrap' } },
            h('span', { class: 'badge ' + (c.enabled ? 'admin' : 'off') }, c.enabled ? 'On' : 'Off'),
            h('span', {}, c.enabled
              ? 'Model ' + c.model + ' · effort ' + c.effort + ' · ' + c.perHour + ' requests per person per hour'
              : 'Not switched on. Add ANTHROPIC_API_KEY to the server settings and restart (see the README).'),
            h('span', { class: 'grow' }), test),
          result);
      } catch (e) { claudeBox.replaceChildren(h('p', { class: 'error' }, e.message)); }
    }

    async function load() {
      drawClaude();
      try {
        const [u, i] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/invites')]);
        drawUsers(u.users);
        drawInvites(i.invites);
      } catch (e) { toast(e.message, { error: true }); }
    }

    function drawUsers(users) {
      const me = state.user;
      const rows = users.map((u) => {
        const sel = h('select', { 'aria-label': 'Role for ' + u.name, onchange: async () => {
          try { await api('PATCH', '/api/admin/users/' + u.id, { role: sel.value }); toast('Role updated'); } catch (e) { toast(e.message, { error: true }); }
          load();
        } }, ['admin', 'editor', 'viewer'].map((r) => h('option', { value: r, selected: r === u.role ? true : undefined }, r)));
        sel.value = u.role;
        return h('tr', {},
          h('td', {}, h('div', { class: 'row' }, avatar(u), h('div', {}, h('strong', {}, u.name + (u.id === me.id ? ' (you)' : '')), h('div', { class: 'small muted' }, u.email)))),
          h('td', {}, sel),
          h('td', {}, u.disabled ? h('span', { class: 'badge off' }, 'disabled') : h('span', { class: 'badge' }, 'active')),
          h('td', {}, h('div', { class: 'actions' },
            u.id === me.id ? null : h('button', { class: 'btn sm', type: 'button', onclick: async () => {
              try { await api('PATCH', '/api/admin/users/' + u.id, { disabled: !u.disabled }); } catch (e) { toast(e.message, { error: true }); }
              load();
            } }, u.disabled ? 'Enable' : 'Disable'),
            u.id === me.id ? null : h('button', { class: 'btn sm danger', type: 'button', onclick: () => modal({
              title: 'Remove ' + u.name + '?',
              content: h('p', {}, 'Their account is deleted and they are signed out. Maps they created stay, with no owner.'),
              buttons: [{ label: 'Cancel' }, { label: 'Remove', danger: true, onClick: async () => {
                try { await api('DELETE', '/api/admin/users/' + u.id); toast('Removed'); } catch (e) { toast(e.message, { error: true }); }
                load();
              } }],
            }) }, 'Remove'))));
      });
      usersBox.replaceChildren(h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Person'), h('th', {}, 'Role'), h('th', {}, 'Status'), h('th', {}))), h('tbody', {}, rows)));
    }

    function drawInvites(invites) {
      if (!invites.length) {
        invitesBox.replaceChildren(h('div', { class: 'empty' }, 'No invites yet.'));
        return;
      }
      const rows = invites.map((i) => {
        const used = !!i.used_at;
        const expired = !used && i.expires_at < Date.now();
        const state = used ? 'Joined' + (i.used_by_name ? ' as ' + i.used_by_name : '') : expired ? 'Expired' : 'Waiting · expires ' + new Date(i.expires_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
        return h('tr', {},
          h('td', {}, i.note || h('span', { class: 'muted' }, '—')),
          h('td', {}, h('span', { class: 'badge ' + i.role }, i.role)),
          h('td', { class: used ? 'muted' : '' }, state),
          h('td', {}, h('div', { class: 'actions' }, h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
            try { await api('DELETE', '/api/admin/invites/' + i.id); } catch (e) { toast(e.message, { error: true }); }
            load();
          } }, used || expired ? 'Clear' : 'Revoke'))));
      });
      invitesBox.replaceChildren(h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', {}, 'For'), h('th', {}, 'Role'), h('th', {}, 'Status'), h('th', {}))), h('tbody', {}, rows)));
    }

    async function createInvite() {
      try {
        const r = await api('POST', '/api/admin/invites', { role: role.value, note: note.value });
        const link = location.origin + '/#/invite/' + r.token;
        const box = h('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Invite link' });
        const copy = h('button', { class: 'btn primary', type: 'button' }, icon('copy'), 'Copy');
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(link); } catch { box.select(); document.execCommand && document.execCommand('copy'); }
          toast('Link copied');
        });
        note.value = '';
        modal({
          title: 'Invite link ready',
          content: h('div', { class: 'stack' },
            h('p', {}, 'Send this link to the person you are inviting. It works once, for ' + r.role + ' access, and expires in 7 days.'),
            h('div', { class: 'linkbox' }, box, copy),
            h('p', { class: 'small muted' }, 'This is the only time the link is shown. Anyone who has it can create an account, so share it privately.')),
          buttons: [{ label: 'Done', primary: true }],
        });
        box.select();
        load();
      } catch (e) { toast(e.message, { error: true }); }
    }

    root.replaceChildren(topbar(), h('main', { class: 'page', id: 'main' },
      h('div', { class: 'page-head' }, h('a', { class: 'btn ghost sm', href: '#/' }, icon('back'), 'Maps'), h('h1', {}, 'People')),
      h('section', { class: 'section' }, h('h2', {}, 'Invite someone'),
        h('div', { class: 'card', style: { padding: '16px' } }, h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 260px' } }, role), h('div', { style: { flex: '2 1 260px' } }, note),
          h('button', { class: 'btn primary', type: 'button', onclick: createInvite }, icon('plus'), 'Create invite link')))),
      h('section', { class: 'section' }, h('h2', {}, 'Claude assistant'), claudeBox),
      h('section', { class: 'section' }, h('h2', {}, 'Team'), usersBox),
      h('section', { class: 'section' }, h('h2', {}, 'Invites'), invitesBox)));
    load();
  }

  boot();
})();
