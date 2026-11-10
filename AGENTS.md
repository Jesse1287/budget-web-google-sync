# Roux Budget (budget-sync)

Zero-based envelope budgeting PWA. **No backend**: Google Drive holds the durable `budget.db` (SQLite); the browser is a cache. The repo root is deployed as-is to GitHub Pages — there is no build step.

## Stack

Plain JS, no bundler. `index.html` loads bootstrap@5.3.0 + sql.js@1.10.3 from the jsDelivr CDN, then `backend.js` → `drive.js` → `app.js` (all with `?v=9` cache-busting).

- `index.html` — UI (Bootstrap 5)
- `app.js` — frontend behavior + two-way Drive sync orchestration
- `backend.js` — SQL.js (WASM SQLite) data layer; `budget.db` is a plain SQLite file
- `drive.js` — Google sign-in (OAuth code + PKCE) and Drive sync
- `manifest.json` / `sw.js` — PWA; service-worker cache is named `roux-budget-web-v9`
- `icons/` — PWA icons
- `reference/` — **gitignored**, local-only copy of the old Flask/Docker version, kept for reference; never deployed

Personal financial data (`budget.db`) is intentionally **not** in this repository. Never commit one.

## Google Drive OAuth — critical constraints

- One owner-maintained OAuth client: **Desktop application type** (public client), GCP project `807813400626`, scopes `drive.file` + `openid email profile`. The client ID is bundled at `drive.js:6`.
- Flow is authorization code + PKCE (S256). **There is no client secret anywhere** — public client; token requests send only `client_id` + `code_verifier` (code exchange and refresh).
- **If the client ID is ever replaced, the replacement must be a public type (Desktop/Android/iOS/TV).** A "Web application" type client makes the token exchange fail with `invalid_client` / "Client Secret is required, please provide your client secret." This exact bug hit 2026-11-10: the old client `807813400626-uoihghs0oj9fk47a8o1tgsb3jjacp9es` was Web-application type and broke sign-in; it was replaced with the current Desktop-type client `807813400626-v1uho4bh1rtec8fhidb49shgr23mrpjj`.
- Desktop clients need **no authorized redirect URIs**: the app computes the redirect as `location.origin + location.pathname` (minus `index.html`), so `localhost:8080` and any GitHub Pages origin work with zero console configuration.
- Tokens live in `localStorage` under `budget.gsync.*` keys. After a client-ID change, old refresh tokens fail with `invalid_grant` — the app auto-clears auth and prompts one-time re-consent. That is expected migration cost, not a bug.
- Diagnostics: `Drive.debug()` (drive.js) fetches Google tokeninfo for the current access token.

## Data + sync model

- Drive's `budget.db` is the single durable copy; IndexedDB is only a local cache so the app opens before Drive is reachable.
- Save → push (media `PATCH` onto the fixed Drive file); load → pull; while open, the app polls Drive every few seconds so other signed-in devices pick up changes in seconds.
- First sign-in: an existing local budget is uploaded once (never silently overwritten).
- New-period workflow: saves, uploads a period backup to Drive, then carries envelope balances forward.

## Run locally

```bash
python3 -m http.server 8080   # → http://localhost:8080
```

## Deploy — GitHub Pages

- Project site from `main`, **public** repo: https://jesse1287.github.io/budget-web-google-sync/
- Repo root == deploy dir, so **use relative paths only** (`./` start_url, relative href/src).
- Cache busting has two layers: the `?v=N` query on the three local script tags in `index.html`, and the `CACHE` name in `sw.js`. A release = bump both in one commit (bump the `PRECACHE` list too if paths change).

## Git (from this machine)

- Commit identity: `Jesse1287 <jesse@users.noreply.github.com>` (already set in this repo's local git config).
- Push with the GitHub token at `/home/Jesse/.github-token` using a **one-shot URL** (never store the token in `.git/config`) and redact it in any logged output:

```bash
cd /Volume1/Data/budget-sync
TOKEN=$(cat /home/Jesse/.github-token)
git push "https://x-access-token:${TOKEN}@github.com/Jesse1287/budget-web-google-sync.git" main 2>&1 | sed "s/${TOKEN}/<redacted>/g"
git update-ref refs/remotes/origin/main HEAD   # one-shot URL doesn't update the tracking ref
```
