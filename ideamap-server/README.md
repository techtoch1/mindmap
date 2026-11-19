# Idea Map

A multi-user, real-time mind-mapping app for marketing ideas, by Aligned.

- Node.js 20+ and SQLite (`better-sqlite3`), live co-editing over WebSocket (`ws`). No frontend build step.
- Two runtime dependencies: `better-sqlite3` and `ws`. The browser code is plain JavaScript served as static files.

## Features

**People and access**
- First visit creates the admin. After that, sign-up only works through invite links.
- Admins create one-time invite links (7-day expiry) with a role: **Admin**, **Editor** or **Viewer**.
- Admins can change roles, disable or remove people, and revoke invites. The last active admin cannot be removed.
- Every role check happens on the server (REST and WebSocket). Changing a role or disabling someone applies immediately, including to open maps.

**Maps**
- Shared library with search (title and idea text), starter templates, duplicate, rename, delete, JSON import/export.
- Editor: add/edit/delete ideas, drag to move, drop on another idea to re-parent, eight colours, **tidy layout**, PNG export.
- **Fold** branches. Fold state is per person and saved for you only.
- **Undo/redo of your own changes** (Ctrl+Z / Ctrl+Shift+Z). It never reverts other people's edits.
- Live cursors, live selections and avatars for everyone in the map. View-only people can watch and follow along.
- Keyboard: `Tab` add idea, `Enter` add sibling, `F2` edit, `Del` delete, arrows to move around, `+`/`-`/`0` zoom and fit. Pinch-zoom on touch screens.

**Claude assistant (optional)**
- **Ask Claude** opens a side panel in the editor. Ask it to add ideas, rename, recolour, move, delete or tidy, or just ask for advice.
- Claude only **proposes**. You see a list of changes and click **Apply**. The whole proposal is one undo step (Ctrl+Z) and goes live for everyone in the map. **Dismiss** throws it away.
- Editors and admins only. Viewers do not see it.
- Off until `ANTHROPIC_API_KEY` is set. See [Claude assistant setup](#claude-assistant-setup).

**Brand**
- IBM Plex Sans (self-hosted, SIL OFL), Poseidon blue `#187bcd`, charcoal `#333334`, light and dark themes (follows the system, switchable from the account menu).

## Run it locally

```bash
cd ideamap-server
npm install
npm test
npm start          # http://127.0.0.1:3000
```

Open the page, create the admin, then invite people from **People**.

## Configuration

All settings are environment variables. See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on (cPanel/Passenger sets this itself) |
| `HOST` | `127.0.0.1` | Interface to bind to |
| `DATA_DIR` | `./data` | Where `ideamap.db` lives. **Keep it outside the web root and back it up.** |
| `TRUST_PROXY` | off | Set `1` behind Apache/nginx/Cloudflare so the real client address and host are used |
| `COOKIE_SECURE` | off | Set `1` on HTTPS: `__Host-` Secure session cookie and HSTS |
| `PUBLIC_URL` | none | Optional extra allowed origin, e.g. `https://ideamap.aligned-tech.com` |
| `SETUP_TOKEN` | none | Optional. If set, creating the first admin requires this secret |
| `ANTHROPIC_API_KEY` | none | Switches the Claude assistant on. Server-side only, never sent to browsers |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used for the assistant |
| `CLAUDE_EFFORT` | `medium` | `low`, `medium`, `high`, `xhigh` or `max`. Higher thinks longer and costs more |
| `AI_REQUESTS_PER_HOUR` | `60` | Per person, to cap spend |
| `CLAUDE_FALLBACK` | on | Retry on a fallback model if Claude declines. `0` turns it off |

## Claude assistant setup

1. Create an API key at https://console.anthropic.com (Settings, API keys). Set a monthly spend limit there too.
2. Add it to the server's settings file **without** echoing it on screen or into shell history:

   ```bash
   read -s -p "Paste your Anthropic API key: " KEY; echo
   printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" >> ~/ideamap.env; unset KEY
   sudo systemctl restart ideamap
   ```
3. Sign in as admin, open **People**, and press **Test connection** under *Claude assistant*. It runs the exact request a real question uses and shows any error in plain words.

How it stays safe:
- The key lives only in the server's environment. Browsers never receive it.
- Claude cannot change a map. It returns a proposal in a fixed format. The server turns it into the same operations the editor uses, dry-runs them on a copy of the map, drops anything invalid (unknown ideas, deleting the central idea, duplicates), and the browser applies the result only when a person clicks **Apply**.
- Idea text and the map title are given to Claude as data, with instructions to ignore any commands found in them. A teammate typing "ignore your rules" into an idea cannot make changes happen, because nothing is applied without a click.
- Limits: 60 requests per person per hour, one at a time per person, 2,000 characters per request, at most 100 changes per proposal.
- Privacy: the map's title and idea text are sent to Anthropic whenever someone asks Claude. Nothing is sent otherwise. Do not enable this if maps may hold information that must not leave your servers.
- Cost: you pay Anthropic per request. A typical request on the default model is a few cents. `CLAUDE_MODEL=claude-sonnet-5-5` is roughly half the price.

## Security notes

- Passwords: scrypt (N=16384, r=8, p=1, random salt), constant-time compare, minimum 10 characters.
- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` and `__Host-` prefixed when `COOKIE_SECURE=1`). Only a SHA-256 hash of the token is stored. 14-day expiry. Changing your password signs out your other devices.
- Invite tokens: 256-bit random, only the hash is stored, single use, 7-day expiry. The token sits in the URL fragment so it is not sent to servers or logged.
- Login throttling: 6 failures per email+address and 30 per address in 15 minutes, then HTTP 429. Unknown emails cost the same time as real ones.
- CSRF: every state-changing request needs the `X-Idea-Map: 1` header, authenticated ones also need the per-session `X-CSRF-Token`, and a present `Origin` header must match.
- WebSocket: session cookie required, `Origin` must match the host (or `PUBLIC_URL`), 64 KB message cap, per-connection rate limit.
- Strict CSP (`script-src 'self'`, `style-src 'self'`, no inline anything, `frame-ancestors 'none'`), plus `nosniff`, `no-referrer` and `X-Frame-Options`.
- All user text is rendered with `textContent`, never as HTML.
- Edits are validated by the same document engine on the server and in the browser (`public/doc.js`): size limits (2,000 ideas, 500 characters, 60 levels), a whitelist of operations, cycle checks.

**Claim the app straight after deploying.** Until the first admin exists, whoever opens the page first becomes the admin. Set `SETUP_TOKEN` if you want to rule that out.

## How real-time editing works

The server keeps each open map in memory and is the single source of truth. Clients send small operations (add, text, move, re-parent, delete, colour, layout). The server validates and applies each one, numbers it, saves to SQLite within ~0.4 s, and broadcasts it. Clients show their own edits instantly and re-apply them on top of the server's order, so everyone converges. If a client ever sees a gap in the sequence, it reconnects and re-syncs.

Because map state lives in one process's memory, **run a single instance** of the app. Running several processes against the same database would make live editing diverge.

## Backups

Everything is in `DATA_DIR/ideamap.db` (SQLite, WAL mode). To back up safely while running:

```bash
sqlite3 "$DATA_DIR/ideamap.db" ".backup '/path/to/backup.db'"
```

Individual maps can also be downloaded as JSON from the library.

## Layout

```
server.js            startup file (always listens; works under Passenger)
src/app.js           HTTP routes, auth, invites, roles, security headers
src/realtime.js      WebSocket hub: rooms, ops, undo/redo, presence
src/db.js            SQLite schema
src/security.js      scrypt, tokens, login throttle
src/ai.js            Claude assistant: prompt, proposal checking, limits
src/templates.js     starter maps
public/doc.js        document engine shared by server and browser
public/editor.js     canvas editor     public/app.js  screens and routing
public/ai-panel.js   Ask Claude panel
test/                node:test suites (npm test)
```

## Known limits

- No password reset yet. An admin can remove the account and send a new invite.
- Email is not sent by the app. Invite links are copied and shared by the admin.
- Fonts are Latin only.
- Claude answers appear all at once after a few seconds (no word-by-word streaming yet).

## Fonts

IBM Plex Sans is © IBM, SIL Open Font License 1.1 (`public/fonts/OFL-LICENSE.txt`).
