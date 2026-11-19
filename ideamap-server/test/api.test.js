'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { start } = require('./helper');
const { sha256 } = require('../src/security');

test('first visit creates the admin exactly once', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const st = await s.req('GET', '/api/session');
  assert.equal(st.json.needsSetup, true);
  assert.equal(st.json.user, null);
  const admin = await s.setupAdmin();
  assert.equal(admin.user.role, 'admin');
  const again = await s.req('POST', '/api/setup', { body: { name: 'Mallory', email: 'm@example.com', password: 'a very long password' } });
  assert.equal(again.status, 409);
  const after = await s.req('GET', '/api/session', { cookie: admin.cookie });
  assert.equal(after.json.needsSetup, false);
  assert.equal(after.json.user.email, 'admin@example.com');
});

test('setup validates input and honours SETUP_TOKEN', async (t) => {
  const s = await start({ SETUP_TOKEN: 'letmein-123' });
  t.after(() => s.close());
  const body = { name: 'A', email: 'a@example.com', password: 'a very long password' };
  assert.equal((await s.req('POST', '/api/setup', { body })).status, 403);
  assert.equal((await s.req('POST', '/api/setup', { body: { ...body, setupToken: 'letmein-123', password: 'short' } })).status, 400);
  assert.equal((await s.req('POST', '/api/setup', { body: { ...body, setupToken: 'letmein-123', email: 'nope' } })).status, 400);
  assert.equal((await s.req('POST', '/api/setup', { body: { ...body, setupToken: 'letmein-123' } })).status, 200);
});

test('passwords are stored as scrypt hashes, sessions as hashes, cookie is HttpOnly + SameSite', async (t) => {
  const s = await start({ COOKIE_SECURE: '1' });
  t.after(() => s.close());
  const r = await s.req('POST', '/api/setup', { body: { name: 'A', email: 'a@example.com', password: 'correct horse battery' } });
  const raw = r.headers['set-cookie'][0];
  assert.match(raw, /^__Host-idm=/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Secure/);
  assert.match(raw, /Path=\//);
  const row = s.app.db.prepare('SELECT password_hash FROM users').get();
  assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!row.password_hash.includes('correct horse'));
  const token = raw.split(';')[0].split('=')[1];
  assert.ok(s.app.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(sha256(token)));
  assert.equal(s.app.db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token), undefined);
  assert.match(r.headers['strict-transport-security'], /max-age/);
});

test('security headers: strict CSP and friends on pages and API', async (t) => {
  const s = await start();
  t.after(() => s.close());
  for (const p of ['/', '/api/session']) {
    const r = await s.req('GET', p);
    const csp = r.headers['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  }
  assert.equal((await s.req('GET', '/api/session')).headers['cache-control'], 'no-store');
});

test('the app shell has no inline scripts or styles (CSP safe)', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const html = (await s.req('GET', '/')).text;
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/i);
  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son\w+=/i);
});

test('static serving blocks path traversal and dotfiles', async (t) => {
  const s = await start();
  t.after(() => s.close());
  assert.equal((await s.req('GET', '/app.js')).status, 200);
  assert.equal((await s.req('GET', '/fonts/ibm-plex-sans-latin-400-normal.woff2')).status, 200);
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fsrc/app.js', '/fonts/../../server.js', '/%00', '/.env']) {
    const r = await s.req('GET', p);
    assert.ok(r.status === 404 || r.status === 400, p + ' -> ' + r.status);
    assert.doesNotMatch(r.text, /createApp|scrypt/);
  }
});

test('login: wrong password fails generically, success sets a session, logout ends it', async (t) => {
  const s = await start();
  t.after(() => s.close());
  await s.setupAdmin();
  const bad = await s.req('POST', '/api/login', { body: { email: 'admin@example.com', password: 'wrong wrong wrong' } });
  const unknown = await s.req('POST', '/api/login', { body: { email: 'nobody@example.com', password: 'wrong wrong wrong' } });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(bad.json.error, unknown.json.error);
  const ok = await s.req('POST', '/api/login', { body: { email: 'ADMIN@example.com', password: 'correct horse battery' } });
  assert.equal(ok.status, 200);
  const me = s.wrap(ok.cookie, ok.json.csrf, ok.json.user);
  assert.equal((await me.api('GET', '/api/maps')).status, 200);
  assert.equal((await me.api('POST', '/api/logout')).status, 200);
  assert.equal((await s.req('GET', '/api/maps', { cookie: ok.cookie })).status, 401);
});

test('login throttling locks after repeated failures, even with the right password', async (t) => {
  const s = await start();
  t.after(() => s.close());
  await s.setupAdmin();
  let last;
  for (let i = 0; i < 6; i++) last = await s.req('POST', '/api/login', { body: { email: 'admin@example.com', password: 'wrong wrong wrong' } });
  assert.equal(last.status, 401);
  const locked = await s.req('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct horse battery' } });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);
});

test('CSRF: mutating requests need the custom header and the session token', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const noHeader = await s.req('POST', '/api/maps', { body: { title: 'x' }, cookie: admin.cookie, csrf: admin.csrf, headers: { 'x-idea-map': '' } });
  assert.equal(noHeader.status, 403);
  const noToken = await s.req('POST', '/api/maps', { body: { title: 'x' }, cookie: admin.cookie });
  assert.equal(noToken.status, 403);
  const wrongToken = await s.req('POST', '/api/maps', { body: { title: 'x' }, cookie: admin.cookie, csrf: 'nope' });
  assert.equal(wrongToken.status, 403);
  const evil = await s.req('POST', '/api/maps', { body: { title: 'x' }, cookie: admin.cookie, csrf: admin.csrf, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const ok = await s.req('POST', '/api/maps', { body: { title: 'x' }, cookie: admin.cookie, csrf: admin.csrf, headers: { origin: s.origin } });
  assert.equal(ok.status, 200);
  const form = await s.req('POST', '/api/maps', { raw: 'title=x', cookie: admin.cookie, csrf: admin.csrf, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415);
});

test('invites are single-use, expire after 7 days and assign the chosen role', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const inv = await admin.api('POST', '/api/admin/invites', { role: 'editor', note: 'for Sam' });
  assert.equal(inv.status, 200);
  const days = (inv.json.expiresAt - Date.now()) / 86400000;
  assert.ok(days > 6.99 && days <= 7.001, 'expiry ~7 days, got ' + days);
  // only the hash is stored
  assert.equal(s.app.db.prepare('SELECT 1 FROM invites WHERE token_hash = ?').get(inv.json.token), undefined);
  const info = await s.req('GET', `/api/invites/${inv.json.token}`);
  assert.equal(info.json.role, 'editor');
  assert.equal(info.json.note, 'for Sam');
  const body = { name: 'Sam', email: 'sam@example.com', password: 'another long password' };
  const first = await s.req('POST', `/api/invites/${inv.json.token}/accept`, { body });
  assert.equal(first.status, 200);
  assert.equal(first.json.user.role, 'editor');
  const second = await s.req('POST', `/api/invites/${inv.json.token}/accept`, { body: { ...body, email: 'other@example.com' } });
  assert.equal(second.status, 404);
  assert.equal((await s.req('GET', `/api/invites/${inv.json.token}`)).status, 404);

  const old = await admin.api('POST', '/api/admin/invites', { role: 'viewer' });
  s.app.db.prepare('UPDATE invites SET expires_at = ?').run(Date.now() - 1000);
  assert.equal((await s.req('GET', `/api/invites/${old.json.token}`)).status, 404);
  assert.equal((await s.req('POST', `/api/invites/${old.json.token}/accept`, { body: { ...body, email: 'late@example.com' } })).status, 404);
  assert.equal((await s.req('GET', '/api/invites/not-a-real-token-at-all-12345')).status, 404);
});

test('invite acceptance rejects an email that already has an account without burning the invite', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const inv = await admin.api('POST', '/api/admin/invites', { role: 'viewer' });
  const dup = await s.req('POST', `/api/invites/${inv.json.token}/accept`, { body: { name: 'X', email: 'admin@example.com', password: 'another long password' } });
  assert.equal(dup.status, 409);
  const ok = await s.req('POST', `/api/invites/${inv.json.token}/accept`, { body: { name: 'X', email: 'x@example.com', password: 'another long password' } });
  assert.equal(ok.status, 200);
});

test('roles are enforced on the server', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const editor = await s.invite(admin, 'editor', 'ed@example.com', 'Ed');
  const editor2 = await s.invite(admin, 'editor', 'ed2@example.com', 'Ed Two');
  const viewer = await s.invite(admin, 'viewer', 'v@example.com', 'Vi');

  // viewer: read yes, write no
  assert.equal((await viewer.api('GET', '/api/maps')).status, 200);
  assert.equal((await viewer.api('POST', '/api/maps', { title: 'nope' })).status, 403);
  assert.equal((await viewer.api('POST', '/api/maps/import', { data: {} })).status, 403);
  assert.equal((await viewer.api('GET', '/api/admin/users')).status, 403);
  assert.equal((await viewer.api('POST', '/api/admin/invites', { role: 'admin' })).status, 403);

  // editor: can create, cannot administer
  const created = await editor.api('POST', '/api/maps', { title: 'Ed map' });
  assert.equal(created.status, 200);
  const id = created.json.map.id;
  assert.equal((await editor.api('GET', '/api/admin/users')).status, 403);
  assert.equal((await editor.api('POST', '/api/admin/invites', { role: 'editor' })).status, 403);
  assert.equal((await viewer.api('PATCH', `/api/maps/${id}`, { title: 'hax' })).status, 403);
  assert.equal((await viewer.api('DELETE', `/api/maps/${id}`)).status, 403);
  assert.equal((await viewer.api('POST', `/api/maps/${id}/duplicate`)).status, 403);
  assert.equal((await viewer.api('GET', `/api/maps/${id}`)).status, 200);
  assert.equal((await viewer.api('GET', `/api/maps/${id}/export`)).status, 200);

  // another editor can rename but cannot delete someone else's map; admin can
  assert.equal((await editor2.api('PATCH', `/api/maps/${id}`, { title: 'Renamed' })).status, 200);
  assert.equal((await editor2.api('DELETE', `/api/maps/${id}`)).status, 403);
  assert.equal((await admin.api('DELETE', `/api/maps/${id}`)).status, 200);
  assert.equal((await viewer.api('GET', `/api/maps/${id}`)).status, 404);

  // unauthenticated
  assert.equal((await s.req('GET', '/api/maps')).status, 401);
  assert.equal((await s.req('GET', '/api/admin/users')).status, 401);
});

test('map library: templates, create, search, rename, duplicate, delete', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const tpls = await admin.api('GET', '/api/templates');
  assert.ok(tpls.json.templates.length >= 4);
  const c = await admin.api('POST', '/api/maps', { template: 'campaign' });
  assert.equal(c.json.map.title, 'Campaign brainstorm');
  assert.ok(c.json.map.nodeCount > 10);
  assert.equal((await admin.api('POST', '/api/maps', { template: 'nope' })).status, 400);
  const blank = await admin.api('POST', '/api/maps', { title: 'Q3 Newsletter ideas' });
  assert.equal(blank.json.map.nodeCount, 1);

  const byTitle = await admin.api('GET', '/api/maps?q=newsletter');
  assert.deepEqual(byTitle.json.maps.map((m) => m.title), ['Q3 Newsletter ideas']);
  const byNode = await admin.api('GET', '/api/maps?q=pain%20points');
  assert.deepEqual(byNode.json.maps.map((m) => m.title), ['Campaign brainstorm']);
  assert.equal((await admin.api('GET', '/api/maps?q=%25')).json.maps.length, 0, 'wildcards are escaped');
  assert.equal((await admin.api('GET', '/api/maps')).json.maps.length, 2);

  const id = blank.json.map.id;
  assert.equal((await admin.api('PATCH', `/api/maps/${id}`, { title: '  ' })).status, 400);
  const ren = await admin.api('PATCH', `/api/maps/${id}`, { title: 'Renamed' });
  assert.equal(ren.json.map.title, 'Renamed');
  assert.equal((await admin.api('GET', '/api/maps?q=newsletter')).json.maps.length, 0);
  const dup = await admin.api('POST', `/api/maps/${id}/duplicate`);
  assert.equal(dup.json.map.title, 'Copy of Renamed');
  assert.notEqual(dup.json.map.id, id);
  assert.equal((await admin.api('DELETE', `/api/maps/${dup.json.map.id}`)).status, 200);
  assert.equal((await admin.api('GET', `/api/maps/${dup.json.map.id}`)).status, 404);
  assert.equal((await admin.api('GET', '/api/maps/..%2f..%2fetc')).status, 404);
});

test('JSON export then import produces an equivalent map', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const c = await admin.api('POST', '/api/maps', { template: 'launch' });
  const exp = await admin.api('GET', `/api/maps/${c.json.map.id}/export`);
  assert.equal(exp.status, 200);
  assert.match(exp.headers['content-disposition'], /product-launch\.ideamap\.json/);
  assert.equal(exp.json.format, 'idea-map');
  const imp = await admin.api('POST', '/api/maps/import', { data: exp.json });
  assert.equal(imp.status, 200);
  assert.equal(imp.json.map.nodeCount, c.json.map.nodeCount);
  assert.equal(imp.json.map.title, 'Product launch');
  const exp2 = await admin.api('GET', `/api/maps/${imp.json.map.id}/export`);
  assert.deepEqual(exp2.json.root, exp.json.root);
  assert.equal((await admin.api('POST', '/api/maps/import', { data: { format: 'idea-map', root: 'x' } })).status, 400);
  assert.equal((await admin.api('POST', '/api/maps/import', { data: { hello: 'world' } })).status, 400);
  assert.equal((await admin.api('POST', '/api/maps/import', {})).status, 400);
});

test('admin: change roles, disable users, protect the last admin', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const ed = await s.invite(admin, 'editor', 'ed@example.com');
  assert.equal((await ed.api('GET', '/api/maps')).status, 200);
  assert.equal((await admin.api('PATCH', `/api/admin/users/${ed.user.id}`, { role: 'viewer' })).json.user.role, 'viewer');
  assert.equal((await ed.api('POST', '/api/maps', { title: 'x' })).status, 403, 'demotion applies immediately');
  await admin.api('PATCH', `/api/admin/users/${ed.user.id}`, { disabled: true });
  assert.equal((await ed.api('GET', '/api/maps')).status, 401, 'disabled users lose their session');
  assert.equal((await s.req('POST', '/api/login', { body: { email: 'ed@example.com', password: 'another long password' } })).status, 401);
  assert.equal((await admin.api('PATCH', `/api/admin/users/${admin.user.id}`, { role: 'editor' })).status, 400);
  assert.equal((await admin.api('PATCH', `/api/admin/users/${admin.user.id}`, { disabled: true })).status, 400);
  assert.equal((await admin.api('DELETE', `/api/admin/users/${admin.user.id}`)).status, 400);
  assert.equal((await admin.api('DELETE', `/api/admin/users/${ed.user.id}`)).status, 200);
  const list = await admin.api('GET', '/api/admin/users');
  assert.equal(list.json.users.length, 1);
  const invs = await admin.api('GET', '/api/admin/invites');
  assert.ok(invs.json.invites.length >= 1);
  assert.equal((await admin.api('DELETE', `/api/admin/invites/${invs.json.invites[0].id}`)).status, 200);
});

test('changing your password signs out your other sessions', async (t) => {
  const s = await start();
  t.after(() => s.close());
  const admin = await s.setupAdmin();
  const other = await s.req('POST', '/api/login', { body: { email: 'admin@example.com', password: 'correct horse battery' } });
  assert.equal((await admin.api('POST', '/api/me/password', { current: 'wrong wrong wrong', next: 'a brand new password' })).status, 403);
  assert.equal((await admin.api('POST', '/api/me/password', { current: 'correct horse battery', next: 'short' })).status, 400);
  assert.equal((await admin.api('POST', '/api/me/password', { current: 'correct horse battery', next: 'a brand new password' })).status, 200);
  assert.equal((await s.req('GET', '/api/maps', { cookie: other.cookie })).status, 401);
  assert.equal((await admin.api('GET', '/api/maps')).status, 200);
  assert.equal((await s.req('POST', '/api/login', { body: { email: 'admin@example.com', password: 'a brand new password' } })).status, 200);
});

test('TRUST_PROXY uses the forwarded address for throttling', async (t) => {
  const s = await start({ TRUST_PROXY: '1' });
  t.after(() => s.close());
  await s.setupAdmin();
  const attempt = (ip, pw) => s.req('POST', '/api/login', { body: { email: 'admin@example.com', password: pw }, headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 6; i++) await attempt('203.0.113.9', 'wrong wrong wrong');
  assert.equal((await attempt('203.0.113.9', 'correct horse battery')).status, 429);
  assert.equal((await attempt('203.0.113.77', 'correct horse battery')).status, 200, 'another address is not locked out');
});
