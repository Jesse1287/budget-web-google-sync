# Roux Budget

Zero-based envelope budgeting PWA.

## Features
- Envelope-based budgeting with split expenses and income.
- Google Drive is the durable store: sign in with Google and your `budget.db` is synced to Drive automatically on every change.
- Near-real-time sync: while open, the app polls Drive every few seconds so other signed-in devices pick up changes in seconds.
- Browser storage (IndexedDB) is a fast local cache so the app still opens before Drive is reachable; it never holds the only copy.
- One-time migration: an existing local budget is uploaded to Drive on first sign-in (it is never silently overwritten).
- Import/export of `budget.db` files.
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
Users sign in with their own Google account on first launch; no IDs or scopes to configure. The owner maintains one OAuth client — a **Desktop application** type (public client, authorization code + PKCE, `drive.file` scope, no client secret) in the same GCP project; the client ID is bundled in `drive.js`. Desktop clients accept any redirect URI, so both `localhost` and the deployed origin work without extra configuration.

## Files
- `index.html` — UI
- `app.js` — frontend behavior and two-way sync orchestration
- `backend.js` — browser SQL.js data layer
- `drive.js` — Google sign-in (OAuth code + PKCE) and Drive sync
- `manifest.json` — PWA manifest
- `sw.js` — service worker
