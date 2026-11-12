(function () {
  // Google Drive sync via Google Identity Services' OAuth 2.0 token model.
  //
  // No backend, no client secret, no redirect URI: one owner-configured
  // Web-application client ID is bundled, and each user signs in with their own
  // Google account in a GIS popup. The popup hands this page a short-lived
  // access token (about an hour), which is renewed silently from the Google
  // session already in the browser; when that is not possible the user signs in
  // again with one tap. Drive is the durable store; browser storage is a cache.
  const BUNDLED_CLIENT_ID = '807813400626-uoihghs0oj9fk47a8o1tgsb3jjacp9es.apps.googleusercontent.com';
  const SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ].join(' ');
  const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
  const API_FILES = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_FILES = 'https://www.googleapis.com/upload/drive/v3/files';

  const K = {
    access: 'budget.gsync.access_token',
    exp: 'budget.gsync.access_token_exp',
    refresh: 'budget.gsync.refresh_token',
    account: 'budget.gsync.account',
    fileId: 'budget.gsync.file_id',
    fileName: 'budget.gsync.file_name',
    lastPush: 'budget.gsync.last_push',
    lastPull: 'budget.gsync.last_pull',
    remoteMod: 'budget.gsync.remote_modified',
    uploaded: 'budget.gsync.local_uploaded'
  };
  const LEGACY_FILE_ID = 'budget.drive.file_id';

  let cachedToken = null;
  let tokenExpiresAt = 0;

  // ---------- storage ----------

  function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
  function lsDel(key) { try { localStorage.removeItem(key); } catch {} }

  // Drive returns modifiedTime as RFC3339 ("2026-11-12T10:00:00.000Z"); Number()
  // of that is NaN, so timestamps are parsed here instead. Epoch millis pass
  // straight through, which keeps older stored values working.
  function msOf(t) {
    if (typeof t === 'number') return Number.isFinite(t) && t > 0 ? t : 0;
    if (!t) return 0;
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return n;
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : 0;
  }

  function account() {
    const raw = lsGet(K.account);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function legacyFileId() { return lsGet(LEGACY_FILE_ID) || ''; }
  function clearLegacy() {
    ['budget.drive.file_id', 'budget.drive.file_name', 'budget.drive.access_token', 'budget.drive.access_token_exp'].forEach(lsDel);
  }

  function setFileMeta(fileId, fileName) {
    if (fileId) lsSet(K.fileId, fileId); else lsDel(K.fileId);
    if (fileName) lsSet(K.fileName, fileName); else lsDel(K.fileName);
    if (fileId) clearLegacy(); // file is reachable through the new keys now
  }

  // ---------- sign-in (Google Identity Services, token model) ----------

  let gisPromise = null;
  let tokenClient = null;
  let pending = null;
  let inFlight = null;
  let renewing = false;
  let lastRenewAt = 0;

  function oauth2() {
    return (window.google && window.google.accounts && window.google.accounts.oauth2) || null;
  }

  function loadGis() {
    if (oauth2()) return Promise.resolve(oauth2());
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.defer = true;
      s.onload = () => { oauth2() ? resolve(oauth2()) : reject(new Error('Google sign-in did not load.')); };
      s.onerror = () => { gisPromise = null; reject(new Error('Could not reach Google sign-in. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  function tokenClientFor(g) {
    if (!tokenClient) {
      tokenClient = g.initTokenClient({
        client_id: BUNDLED_CLIENT_ID,
        scope: SCOPES,
        callback: onToken,
        error_callback: onAuthError
      });
    }
    return tokenClient;
  }

  function onToken(resp) {
    const p = pending;
    pending = null;
    if (!p) return;
    if (resp && resp.access_token) p.resolve(resp);
    else p.reject(new Error((resp && (resp.error_description || resp.error)) || 'Google sign-in did not return an access token.'));
  }

  function onAuthError(err) {
    const p = pending;
    pending = null;
    if (!p) return;
    const type = (err && (err.type || err.error)) || '';
    const e = new Error(
      type === 'popup_closed' ? 'The Google sign-in window was closed before finishing.' :
      type === 'popup_failed_to_open' ? 'The browser blocked the Google sign-in window. Allow pop-ups for this site and try again.' :
      'Google sign-in could not start (' + (type || 'unknown error') + ').'
    );
    e.code = type === 'popup_failed_to_open' ? 'POPUP_BLOCKED' : 'AUTH_ERROR';
    p.reject(e);
  }

  function runTokenRequest(prompt) {
    return loadGis().then(g => new Promise((resolve, reject) => {
      const client = tokenClientFor(g);
      pending = { resolve: resolve, reject: reject };
      try {
        client.requestAccessToken({ prompt: prompt || '' });
      } catch (e) {
        pending = null;
        reject(e);
      }
    }));
  }

  // GIS answers one request at a time: a silent renewal may still be in flight
  // when the user clicks Sign in, so queue behind it instead of racing it.
  function requestToken(prompt) {
    if (inFlight) return inFlight.then(() => requestToken(prompt), () => requestToken(prompt));
    const p = runTokenRequest(prompt);
    const done = () => { if (inFlight === p) inFlight = null; };
    inFlight = p;
    p.then(done, done);
    return p;
  }

  async function acceptToken(resp) {
    const secs = Number(resp.expires_in) > 0 ? Number(resp.expires_in) : 3600;
    cachedToken = resp.access_token;
    tokenExpiresAt = Date.now() + secs * 1000;
    lsSet(K.access, cachedToken);
    lsSet(K.exp, String(tokenExpiresAt));
    try {
      const res = await fetch(USERINFO_URL, { headers: { Authorization: 'Bearer ' + cachedToken } });
      if (res.ok) {
        const u = await res.json();
        lsSet(K.account, JSON.stringify({ email: u.email || '', name: u.name || '' }));
      }
    } catch (e) { /* the account label is cosmetic */ }
  }

  function storedToken() { return cachedToken || lsGet(K.access) || ''; }
  function hasSession() { return Boolean(storedToken()); }
  function tokenValid() { return Boolean(cachedToken) && Date.now() < tokenExpiresAt - 60000; }
  function renewalNeeded(bufferMs) { return hasSession() && Date.now() > tokenExpiresAt - (bufferMs || 0); }

  async function signIn(opts) {
    opts = opts || {};
    lsDel(K.refresh); // legacy code-flow refresh tokens are no longer usable
    const prompt = opts.prompt || (account() && hasSession() ? '' : 'consent');
    const resp = await requestToken(prompt);
    await acceptToken(resp);
    return account();
  }

  // Sign-in happens in a GIS popup, so there is no redirect callback; a stale
  // ?code=... URL left over from the old code flow is cleaned up here.
  function handleCallback() {
    const p = new URLSearchParams(location.search);
    if (p.has('code') || p.has('error')) history.replaceState(null, '', location.pathname + location.hash);
    return null;
  }

  // Renews the access token from the Google session already in this browser.
  // GIS shows a popup: it closes by itself while consent is still on file.
  async function renewToken(quiet) {
    if (renewing || Date.now() - lastRenewAt < 60000) return null;
    renewing = true;
    lastRenewAt = Date.now();
    try {
      const resp = await requestToken(quiet ? 'none' : '');
      await acceptToken(resp);
      return cachedToken;
    } catch (e) {
      return null;
    } finally {
      renewing = false;
    }
  }

  function clearAuth() {
    cachedToken = null;
    tokenExpiresAt = 0;
    [K.access, K.exp, K.refresh, K.account, K.fileId, K.fileName, K.lastPush, K.lastPull, K.remoteMod, K.uploaded].forEach(lsDel);
  }

  function hasRefresh() { return hasSession(); } // keeps the app.js contract

  function clearToken() {
    cachedToken = null;
    tokenExpiresAt = 0;
    lsDel(K.access);
    lsDel(K.exp);
  }

  async function refresh() {
    const t = await renewToken(true);
    if (t) return t;
    const e = new Error('Your Google sign-in expired. Sign in again to keep syncing.');
    e.code = 'NOT_SIGNED_IN';
    throw e;
  }

  async function getAccessToken(interactive) {
    if (tokenValid()) return cachedToken;
    const stored = lsGet(K.access);
    const exp = Number(lsGet(K.exp) || 0);
    if (stored && exp > Date.now() + 60000) {
      cachedToken = stored;
      tokenExpiresAt = exp;
      return cachedToken;
    }
    if (hasSession()) return await refresh();
    const e = new Error('Google sign-in is required.');
    e.code = 'NOT_SIGNED_IN';
    throw e;
  }

  function signOut() {
    const t = storedToken();
    clearAuth();
    const g = oauth2();
    if (t && g && g.revoke) { try { g.revoke(t, function () {}); } catch (e) {} }
  }

  // ---------- HTTP ----------

  async function request(path, options, interactive, retried) {
    const token = await getAccessToken(interactive);
    const res = await fetch(path, Object.assign({}, options, {
      headers: Object.assign({ Authorization: 'Bearer ' + token }, options && options.headers)
    }));
    if (res.status === 401 && !retried) {
      // The token was rejected (expired early or revoked): ask GIS for a new one.
      clearToken();
      if (await renewToken(false)) return await request(path, options, interactive, true);
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { const e = await res.json(); msg = e.error && e.error.message ? e.error.message : msg; } catch {}
      const err = new Error('Google Drive: ' + msg);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // ---------- Drive file operations ----------

  async function fetchFile(id) {
    const q = new URLSearchParams({ id: id, fields: 'files(id,name,modifiedTime,md5Checksum,size)' }).toString();
    const res = await request(API_FILES + '?' + q, undefined, true, false);
    const data = await res.json();
    return data.files && data.files[0] ? data.files[0] : null;
  }

  async function findByName(interactive) {
    const q = new URLSearchParams({
      q: "name='budget.db' and trashed=false",
      fields: 'files(id,name,modifiedTime,md5Checksum,size)',
      pageSize: '10',
      orderBy: 'modifiedTime desc'
    }).toString();
    const res = await request(API_FILES + '?' + q, undefined, interactive, false);
    const data = await res.json();
    return data.files && data.files[0] ? data.files[0] : null;
  }

  // Every budget-shaped file this app can see. drive.file only reaches files the
  // app itself created, so this is exactly the set a user may have ended up with
  // after a rename, a copy ("budget (1).db") or an older version of the app.
  // Backups are skipped: they are there to be restored deliberately.
  async function listBudgetFiles() {
    const q = new URLSearchParams({
      q: "trashed=false and name contains '.db'",
      fields: 'files(id,name,modifiedTime,size)',
      orderBy: 'modifiedTime desc',
      pageSize: '100'
    }).toString();
    const res = await request(API_FILES + '?' + q, undefined, true, false);
    const data = await res.json().catch(() => ({}));
    return (data.files || []).filter(f => {
      const n = f.name || '';
      return /\.db$/i.test(n) && !/^budget-(backup|before-merge)-/i.test(n);
    });
  }

  // Metadata for the current budget file (by stored id, by name, or by the
  // pre-sync legacy id). Returns null when Drive has no budget.db yet.
  async function fileMeta(interactive) {
    const fileId = lsGet(K.fileId);
    if (fileId) {
      try {
        const f = await fetchFile(fileId);
        if (f) return f;
        lsDel(K.fileId);
      } catch (e) {
        if (e.status === 404) lsDel(K.fileId);
        else if (e.code !== 'NOT_SIGNED_IN') throw e;
      }
    }
    const byName = await findByName(interactive !== false);
    if (byName) { setFileMeta(byName.id, byName.name); return byName; }
    const legacy = legacyFileId();
    if (legacy) {
      try {
        const f = await fetchFile(legacy);
        if (f) { setFileMeta(f.id, f.name); return f; }
      } catch (e) { /* fall through */ }
    }
    return null;
  }

  async function uploadBytes(bytes, fileName) {
    const file = new Uint8Array(bytes);
    let fileId = fileName === 'budget.db' ? (lsGet(K.fileId) || '') : '';
    if (fileName === 'budget.db' && !fileId) {
      const legacy = legacyFileId();
      if (legacy) fileId = legacy;
    }
    if (fileName === 'budget.db' && !fileId) {
      // No tracked id (a new device, cleared storage): look the file up before
      // creating one. findByName throws when Drive cannot answer, and that must
      // stop the upload — posting a second budget.db because a lookup hiccuped
      // is how several files end up in one account.
      const existing = await findByName(true);
      if (existing) { fileId = existing.id; setFileMeta(existing.id, existing.name); }
      else {
        // Same name, different name ("budget (1).db"), it is still the user's
        // budget. Creating another file here is what duplicated their data, so
        // refuse and send them to the picker instead of guessing.
        const known = await listBudgetFiles();
        if (known.length) {
          const err = new Error('Google Drive already has your budget as "' + known[0].name +
            '". Open Settings → Drive → "Find my budget in Drive" to use that file instead of creating a second one.');
          err.code = 'PICK_FILE';
          throw err;
        }
      }
    }
    if (fileId) {
      try {
        const res = await request(UPLOAD_FILES + '/' + fileId + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/x-sqlite3' }, body: file }, true, false);
        const data = await res.json();
        setFileMeta(data.id, data.name || fileName);
        return { fileId: data.id, fileName: data.name || fileName, modifiedTime: data.modifiedTime || null };
      } catch (e) {
        if (e.status !== 404) throw e;
        lsDel(K.fileId);
        fileId = '';
      }
    }
    const boundary = 'budget' + Date.now();
    const metaJson = JSON.stringify({ name: fileName, mimeType: 'application/x-sqlite3' });
    const blobPart1 = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: application/x-sqlite3\r\n\r\n`], { type: '' });
    const blobPart2 = new Blob([`\r\n--${boundary}--\r\n`], { type: '' });
    const blob = new Blob([blobPart1, file, blobPart2], { type: `multipart/related; boundary=${boundary}` });
    const res = await request(UPLOAD_FILES + '?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: blob }, true, false);
    const data = await res.json();
    if (fileName === 'budget.db') setFileMeta(data.id, data.name || 'budget.db');
    return { fileId: data.id, fileName: data.name || fileName, modifiedTime: data.modifiedTime || null };
  }

  async function push(bytes) {
    const m = await uploadBytes(bytes, 'budget.db');
    lsSet(K.lastPush, String(Date.now()));
    lsSet(K.uploaded, '1');
    if (m.modifiedTime) lsSet(K.remoteMod, m.modifiedTime);
    return m;
  }

  async function pull() {
    const meta = await fileMeta(true);
    if (!meta) throw new Error('No budget.db found in Google Drive yet.');
    const res = await request(API_FILES + '/' + meta.id + '?alt=media', { method: 'GET' }, true, false);
    const bytes = await res.arrayBuffer();
    lsSet(K.remoteMod, meta.modifiedTime || '0');
    lsSet(K.lastPull, String(Date.now()));
    return { bytes: bytes, modifiedTime: meta.modifiedTime || null, fileName: meta.name || 'budget.db' };
  }

  async function uploadBackup(name, bytes) {
    return await uploadBytes(bytes, name);
  }

  // Read one specific file by id, for "which copy do you want to use?".
  async function pullFile(id) {
    const meta = await fetchFile(id);
    if (!meta) throw new Error('That budget file is no longer in Google Drive.');
    const res = await request(API_FILES + '/' + meta.id + '?alt=media', { method: 'GET' }, true, false);
    const bytes = await res.arrayBuffer();
    lsSet(K.remoteMod, meta.modifiedTime || '0');
    lsSet(K.lastPull, String(Date.now()));
    return { bytes: bytes, modifiedTime: meta.modifiedTime || null, fileName: meta.name || '' };
  }

  // Point this browser at a file the user picked, so later saves update it
  // instead of creating another one.
  function setFile(id, name) { setFileMeta(id, name || 'budget.db'); }

  // Rolling backups: list the app's budget-backup-*.db files (newest first)
  // and delete old ones. drive.file scope reaches files the app created.
  async function listBackups() {
    const q = new URLSearchParams({
      q: "name contains 'budget-backup-' and trashed=false",
      fields: 'files(id,name,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: '50'
    }).toString();
    const res = await request(API_FILES + '?' + q, undefined, false, false);
    const data = await res.json().catch(() => ({}));
    return data.files || [];
  }

  async function deleteFile(id) {
    return await request(API_FILES + '/' + id, { method: 'DELETE' }, false, false);
  }

  function lastRemoteModified() { return msOf(lsGet(K.remoteMod)); }
  function lastPushAt() { return Number(lsGet(K.lastPush) || 0); }
  function lastPullAt() { return Number(lsGet(K.lastPull) || 0); }
  function localUploaded() { return lsGet(K.uploaded) === '1'; }

  function status() {
    const a = account();
    return {
      connected: hasRefresh(),
      account: a,
      fileId: lsGet(K.fileId) || '',
      fileName: lsGet(K.fileName) || '',
      lastPush: lastPushAt(),
      lastPull: lastPullAt(),
      remoteModified: lastRemoteModified(),
      localUploaded: localUploaded()
    };
  }

  async function debug() {
    const t = await getAccessToken(true);
    const res = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(t));
    let info = null;
    try { info = await res.json(); } catch (e) {}
    return { tokenLength: t.length, tokenPrefix: t.slice(0, 8), hasRefresh: hasRefresh(), tokenInfoStatus: res.status, tokenInfo: info };
  }

  // ---------- session upkeep ----------

  // Restore the token this browser saved: GIS tokens last about an hour.
  (function restoreSession() {
    const t = lsGet(K.access);
    const exp = Number(lsGet(K.exp) || 0);
    if (t && exp > Date.now()) { cachedToken = t; tokenExpiresAt = exp; }
    lsDel(K.refresh); // legacy code-flow refresh token: unusable without a secret
  })();

  // Renew before the token dies, on the next user gesture so the popup is not
  // blocked, or when the app comes back to the foreground.
  function onGestureRenew(e) {
    const t = e && e.target;
    if (t && t.closest && t.closest('#land-signin, #sync-signin')) return;
    if (renewing || inFlight || !renewalNeeded(8 * 60 * 1000)) return;
    renewToken(false);
  }
  document.addEventListener('pointerdown', onGestureRenew, true);
  document.addEventListener('keydown', onGestureRenew, true);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !renewing && !inFlight && renewalNeeded(60 * 1000)) renewToken(true);
  });

  // Warm the GIS library so the first popup is never blocked by a late load.
  loadGis().catch(() => {});

  window.Drive = {
    // auth
    signIn: signIn,
    handleCallback: handleCallback,
    signOut: signOut,
    account: account,
    hasRefresh: hasRefresh,
    tokenValid: tokenValid,
    // sync primitives
    fileMeta: fileMeta,
    push: push,
    pull: pull,
    pullFile: pullFile,
    listBudgetFiles: listBudgetFiles,
    setFile: setFile,
    uploadBackup: uploadBackup,
    listBackups: listBackups,
    deleteFile: deleteFile,
    lastRemoteModified: lastRemoteModified,
    lastPushAt: lastPushAt,
    lastPullAt: lastPullAt,
    localUploaded: localUploaded,
    clearLegacy: clearLegacy,
    // diagnostics
    status: status,
    debug: debug,
    // legacy compatibility (v8 callers)
    getClientId: function () { return BUNDLED_CLIENT_ID; },
    saveClientId: function () { return { clientId: BUNDLED_CLIENT_ID, fileId: '', fileName: '' }; },
    hasToken: function () { return Boolean(cachedToken && Date.now() < tokenExpiresAt - 60000) || hasRefresh(); },
    isConnected: function () { return hasRefresh() && Boolean(lsGet(K.fileId)); },
    async openLatest() { const r = await pull(); return r.bytes; },
    async upload(bytes, opts) { return await push(bytes); },
    async connect() { return await fileMeta(true); }
  };
})();
