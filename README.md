# Roux Budget

Zero-based envelope budgeting PWA.

## Features
- Envelope-based budgeting with split expenses and income.
- Google Drive is the durable store: sign in with Google and your `budget.db` is synced to Drive automatically on every change.
- Near-real-time sync: while open, the app polls Drive every few seconds so other signed-in devices pick up changes in seconds.
- Browser storage (IndexedDB) is a fast local cache so the app still opens before Drive is reachable; it never holds the only copy.
- One-time migration: an existing local budget is uploaded to Drive on first sign-in (it is never silently overwritten).
- Import/export of `budget.db` files, including **Settings → Data → Import .db**: picks a file made by an older copy of the app (or another Google account), checks it read-only, copies the current budget to Drive as a backup, then replaces the budget everywhere and pushes it.
- Built-in **Help** tab: a plain-language setup guide (categories → checks → today's balance) plus everyday use, periods, and sync.
- Safety nets: **Undo** after a delete, a daily rolling backup in Drive (last 7 kept), a local `.db` copy when a period closes, and a conflict prompt when two devices change the budget at the same time.
- Recurring paycheck and income templates.
- New period workflow that saves, uploads a period backup to Drive, then carries forward envelope balances.

## Run locally
Serve this directory over HTTP:
```bash
python3 -m http.server 8080
```
Open `http://localhost:8080`.

## GitHub Pages
Deploy this directory as a project site. Use relative paths and ensure the repository is public for free GitHub Pages.

## Google Drive
Users sign in with their own Google account on first launch; no IDs or scopes to configure. The owner maintains one OAuth client in GCP project `807813400626`:

- Type: **Web application** (the only type that accepts a `https://` origin such as GitHub Pages).
- **Authorized JavaScript origins**: `https://jesse1287.github.io` and `http://localhost:8080`. Required — the sign-in popup is origin-checked.
- Authorized redirect URIs are not used by this app (the token model has no redirect), but keeping the site origin there is harmless.
- Scopes: `drive.file`, `userinfo.email`, `userinfo.profile`.

The client ID is bundled in `drive.js`. Sign-in uses **Google Identity Services' OAuth 2.0 token model** (`initTokenClient`): a popup returns a short-lived access token (~1 hour) straight to the page, so there is **no client secret and no backend**. The token is renewed silently from the Google session already in the browser (on the next tap after it ages out, or when the app returns to the foreground); when Google requires interaction the app shows a **Sign in with Google** button. Consequently there is no long-lived refresh token: a device that stays closed for a long time needs one tap to reconnect, and popups must be allowed for the site.

## Files
- `index.html` — UI
- `app.js` — frontend behavior and two-way sync orchestration
- `backend.js` — browser SQL.js data layer
- `drive.js` — Google sign-in (GIS token model) and Drive sync
- `manifest.json` — PWA manifest
- `sw.js` — service worker
