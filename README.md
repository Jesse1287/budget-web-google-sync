# Roux Budget

Zero-based envelope budgeting PWA.

## Features
- Envelope-based budgeting with split expenses and income.
- Local-first storage in the browser using IndexedDB.
- Import/export of `budget.db` files.
- Optional Google Drive backup of `budget.db`.
- Recurring paycheck and income templates.
- New period workflow that saves, optionally uploads to Drive, then carries forward envelope balances.

## Run locally
Serve this directory over HTTP:
```bash
python3 -m http.server 8080
```
Open `http://localhost:8080`.

## GitHub Pages
Deploy this directory as a project site. Use relative paths and ensure the repository is public for free GitHub Pages.

## Google Drive
Add a Google OAuth client ID in Settings → Google Drive. The JavaScript origin should be the deployed app URL.

## Files
- `index.html` — UI
- `app.js` — frontend behavior
- `backend.js` — browser SQL.js data layer
- `drive.js` — Google Drive backup integration
- `manifest.json` — PWA manifest
- `sw.js` — service worker
