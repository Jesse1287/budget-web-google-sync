(function () {
  // Google Drive sync with OAuth 2.0 authorization-code flow + PKCE (no backend).
  // One owner-configured client ID is bundled. Users sign in with their own
  // Google account; a refresh token keeps the connection alive without
  // re-consenting. Drive is the durable store; browser storage is a cache.
  const BUNDLED_CLIENT_ID = '807813400626-uoihghs0oj9fk47a8o1tgsb3jjacp9es.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
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
  const VERIFIER_KEY = 'budget.gsync.code_verifier';
  const STATE_KEY = 'budget.gsync.state';

  let cachedToken = null;
  let tokenExpiresAt = 0;

  // ---------- storage ----------

  function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function lsSet(key, value) { try { localStorage.setItem(key, value); } catch {} }
  function lsDel(key) { try { localStorage.removeItem(key); } catch {} }

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

  // ---------- PKCE helpers ----------

  function b64url(bytes) {
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomBytes(n) {
    const arr = new Uint8Array(n);
    crypto.getRandomValues(arr);
    return arr;
  }

  async function sha256b64url(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return b64url(new Uint8Array(buf));
  }

  // ---------- sign-in ----------

  function buildAuthUrl(prompt) {
    const verifier = b64url(randomBytes(48)); // 64 chars, within 43..128
    const state = b64url(randomBytes(16));
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
    return { verifier, state };
  }

  async function signIn(opts) {
    opts = opts || {};
    const { verifier, state } = buildAuthUrl(opts.prompt);
    const challenge = await sha256b64url(verifier);
    const p = new URLSearchParams({
      client_id: BUNDLED_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: opts.prompt || (hasRefresh() ? 'select_account' : 'consent'),
      state: state
    });
    location.assign(AUTH_URL + '?' + p.toString());
  }

  function storeTokenResponse(data) {
    if (data.access_token) {
      cachedToken = data.access_token;
      tokenExpiresAt = Date.now() + (Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 3600000);
      lsSet(K.access, cachedToken);
      lsSet(K.exp, String(tokenExpiresAt));
    }
    if (data.refresh_token) lsSet(K.refresh, data.refresh_token);
    if (data.id_token) {
      try {
        const payload = JSON.parse(atob(data.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        lsSet(K.account, JSON.stringify({ email: payload.email || '', name: payload.name || '' }));
      } catch {}
    }
  }

  function clearAuth() {
    cachedToken = null;
    tokenExpiresAt = 0;
    [K.access, K.exp, K.refresh, K.account, K.fileId, K.fileName, K.lastPush, K.lastPull, K.remoteMod, K.uploaded].forEach(lsDel);
  }

  // Returns a Promise that resolves with the signed-in account when the page
  // was loaded from the OAuth redirect (URL contains ?code=...), or null when
  // the URL is not a callback.
  function handleCallback() {
    const p = new URLSearchParams(location.search);
    const code = p.get('code');
    const state = p.get('state');
    const err = p.get('error');
    if (!code && !err) return null;
    return (async () => {
      const expectedState = sessionStorage.getItem(STATE_KEY);
      const verifier = sessionStorage.getItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
      if (err) throw new Error('Google sign-in was cancelled or denied.');
      if (!verifier) throw new Error('Sign-in session expired — please sign in again.');
      if (expectedState && state && expectedState !== state) throw new Error('Sign-in state mismatch — please sign in again.');
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        client_id: BUNDLED_CLIENT_ID,
        code_verifier: verifier
      });
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'Google sign-in failed. Try again.');
      }
      storeTokenResponse(data);
      history.replaceState(null, '', location.pathname + location.hash);
      return account();
    })();
  }

  function hasRefresh() { return Boolean(lsGet(K.refresh)); }

  function clearToken() {
    cachedToken = null;
    tokenExpiresAt = 0;
    lsDel(K.access);
    lsDel(K.exp);
  }

  async function refresh() {
    const rt = lsGet(K.refresh);
    if (!rt) throw new Error('Not signed in.');
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: BUNDLED_CLIENT_ID
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      const revoked = /invalid_grant|revoked/i.test(data.error || data.error_description || '');
      clearAuth();
      throw new Error(revoked ? 'Your Google sign-in expired. Please sign in again.' : 'Could not refresh the Google sign-in: ' + (data.error_description || data.error || res.status));
    }
    storeTokenResponse(data);
    return cachedToken;
  }

  async function getAccessToken(interactive) {
    if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
    const stored = lsGet(K.access);
    const exp = Number(lsGet(K.exp) || 0);
    if (stored && exp > Date.now() + 60000) {
      cachedToken = stored;
      tokenExpiresAt = exp;
      return cachedToken;
    }
    if (hasRefresh()) return await refresh();
    const e = new Error('Google sign-in is required.');
    e.code = 'NOT_SIGNED_IN';
    throw e;
  }

  function signOut() {
    clearAuth();
  }

  // ---------- HTTP ----------

  async function request(path, options, interactive, retried) {
    const token = await getAccessToken(interactive);
    const res = await fetch(path, Object.assign({}, options, {
      headers: Object.assign({ Authorization: 'Bearer ' + token }, options && options.headers)
    }));
    if (res.status === 401) {
      clearToken();
      if (!retried && hasRefresh()) return await request(path, options, interactive, true);
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

  function lastRemoteModified() { return Number(lsGet(K.remoteMod) || 0); }
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

  window.Drive = {
    // auth
    signIn: signIn,
    handleCallback: handleCallback,
    signOut: signOut,
    account: account,
    hasRefresh: hasRefresh,
    // sync primitives
    fileMeta: fileMeta,
    push: push,
    pull: pull,
    uploadBackup: uploadBackup,
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
