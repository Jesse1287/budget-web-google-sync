# Roux Budget (budget-sync)

Zero-based envelope budgeting PWA. **No backend**: Google Drive holds the durable `budget.db` (SQLite); the browser is a cache. The repo root is deployed as-is to GitHub Pages — there is no build step.

## Stack

Plain JS, no bundler. `index.html` loads bootstrap@5.3.0 + sql.js@1.10.3 from the jsDelivr CDN, then `backend.js` → `drive.js` → `app.js` (all with `?v=10` cache-busting). `drive.js` lazily loads `https://accounts.google.com/gsi/client` itself, so there is no extra script tag to manage.

- `index.html` — UI (Bootstrap 5)
- `app.js` — frontend behavior + two-way Drive sync orchestration
- `backend.js` — SQL.js (WASM SQLite) data layer; `budget.db` is a plain SQLite file
- `drive.js` — Google sign-in (Google Identity Services token model) and Drive sync
- `manifest.json` / `sw.js` — PWA; service-worker cache is named `roux-budget-web-v10`
- `icons/` — PWA icons
- `reference/` — **gitignored**, local-only copy of the old Flask/Docker version, kept for reference; never deployed

Personal financial data (`budget.db`) is intentionally **not** in this repository. Never commit one.

## Google Drive OAuth — critical constraints

- One owner-maintained OAuth client: **Web application type**, GCP project `807813400626`, client ID `807813400626-uoihghs0oj9fk47a8o1tgsb3jjacp9es` bundled at `drive.js:10`. Scopes `drive.file`, `userinfo.email`, `userinfo.profile`.
- Flow is the **Google Identity Services (GIS) token model**: `google.accounts.oauth2.initTokenClient(...)` in a popup returns an access token (~1 h) directly to the page. **No client secret, no redirect URI, no backend** — that is why a Web-application client (which normally demands a secret for the code flow) is usable here.
- **The client must list the app origins under "Authorized JavaScript origins"** (`https://jesse1287.github.io`, `http://localhost:8080`). GIS rejects unlisted origins. This is the only console-side configuration the app needs.
- **Avoid the authorization-code + PKCE flow for this app.** It needs a confidential client (Web type → `invalid_client` / "Client Secret is required"), while the public client types (Desktop/Android/iOS/TV) only accept loopback redirect URIs, so a Desktop client always fails on GitHub Pages with `redirect_uri_mismatch`. Both were verified empirically 2026-11-10 against `accounts.google.com/o/oauth2/v2/auth`; the bundled client ID changed three times that day (`uoihghs0…` Web → `v1uho4bh…` Desktop → back to `uoihghs0…` Web).
- Tokens live in `localStorage` under `budget.gsync.*` keys; there is **no refresh token** with this model. `drive.js` renews silently (`prompt: 'none'`, or on the next user gesture within 8 min of expiry) and surfaces `NOT_SIGNED_IN` when Google needs interaction — the UI then offers "Sign in with Google" (landing screen and Settings). Popups must be allowed for the site.
- After a client-ID change every signed-in device needs one tap to sign in again; that is expected migration cost, not a bug.
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
