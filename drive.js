(function () {
  const CLIENT_KEY = 'budget.drive.client_id';
  const FILE_ID_KEY = 'budget.drive.file_id';
  const FILE_NAME_KEY = 'budget.drive.file_name';
  const API_FILES = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD_FILES = 'https://www.googleapis.com/upload/drive/v3/files';
  let authPromise = null;
  let cachedToken = null;
  let tokenExpiresAt = 0;

  function getMeta() {
    return {
      clientId: localStorage.getItem(CLIENT_KEY),
      fileId: localStorage.getItem(FILE_ID_KEY),
      fileName: localStorage.getItem(FILE_NAME_KEY) || 'budget.db'
    };
  }

  function saveMeta(patch) {
    const meta = getMeta();
    Object.assign(meta, patch);
    if (meta.clientId) localStorage.setItem(CLIENT_KEY, meta.clientId); else localStorage.removeItem(CLIENT_KEY);
    if (meta.fileId) localStorage.setItem(FILE_ID_KEY, meta.fileId); else localStorage.removeItem(FILE_ID_KEY);
    if (meta.fileName) localStorage.setItem(FILE_NAME_KEY, meta.fileName); else localStorage.removeItem(FILE_NAME_KEY);
    return meta;
  }

  function loadScript() {
    if (window.google && window.google.accounts) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load Google sign-in.'));
      document.head.appendChild(s);
    });
  }

  async function getToken() {
    const meta = getMeta();
    if (!meta.clientId) throw new Error('Save a Google OAuth client ID first.');
    if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
    await loadScript();
    if (!authPromise) {
      authPromise = new Promise((resolve, reject) => {
        let settled = false;
        const client = window.google.accounts.oauth2.initTokenClient({
          client_id: meta.clientId,
          scope: 'https://www.googleapis.com/auth/drive.file',
          callback: (response) => {
            if (settled) return;
            if (response && response.error) {
              settled = true;
              authPromise = null;
              reject(new Error(response.error_description || response.error || 'Drive sign-in was denied'));
              return;
            }
            if (response && response.access_token) {
              settled = true;
              cachedToken = response.access_token;
              tokenExpiresAt = Date.now() + (Number(response.expires_in) > 0 ? Number(response.expires_in) * 1000 : 3600000);
              resolve(cachedToken);
              return;
            }
            settled = true;
            authPromise = null;
            reject(new Error('Drive sign-in did not return a token.'));
          },
          error_callback: (err) => {
            if (settled) return;
            settled = true;
            authPromise = null;
            reject(err instanceof Error ? err : new Error((err && err.message) || 'Drive sign-in was cancelled.'));
          }
        });
        client.requestAccessToken();
      });
    }
    const res = await authPromise;
    authPromise = null;
    return res;
  }

  async function request(path, options, retried) {
    const hadCached = Boolean(cachedToken);
    const token = await getToken();
    const res = await fetch(path, Object.assign({}, options, {
      headers: Object.assign({ Authorization: 'Bearer ' + token }, options && options.headers)
    }));
    if (res.status === 401 && hadCached && !retried) {
      cachedToken = null;
      tokenExpiresAt = 0;
      return request(path, options, true);
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

  async function findFile() {
    const q = new URLSearchParams({ q: "name='budget.db' and trashed=false", fields: 'files(id,name,modifiedTime)', pageSize: '10', orderBy: 'modifiedTime desc' }).toString();
    const res = await request(API_FILES + '?' + q);
    const data = await res.json();
    return data.files && data.files[0] ? data.files[0] : null;
  }

  async function uploadBytes(bytes) {
    const meta = getMeta();
    const file = new Uint8Array(bytes);
    let fileId = meta.fileId;
    if (fileId) {
      const res = await request(UPLOAD_FILES + '/' + fileId, { method: 'PUT', headers: { 'Content-Type': 'application/x-sqlite3' }, body: file });
      const data = await res.json();
      saveMeta({ fileId: data.id, fileName: data.name || 'budget.db' });
      return { fileId: data.id, fileName: data.name || 'budget.db' };
    }
    const boundary = 'budget' + Date.now();
    const metaJson = JSON.stringify({ name: 'budget.db', mimeType: 'application/x-sqlite3' });
    const blobPart1 = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: application/x-sqlite3\r\n\r\n`], { type: '' });
    const blobPart2 = new Blob([`\r\n--${boundary}--\r\n`], { type: '' });
    const blob = new Blob([blobPart1, file, blobPart2], { type: `multipart/related; boundary=${boundary}` });
    const res = await request(UPLOAD_FILES + '?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: blob });
    const data = await res.json();
    saveMeta({ fileId: data.id, fileName: data.name || 'budget.db' });
    return { fileId: data.id, fileName: data.name || 'budget.db' };
  }

  async function downloadFile(id) {
    const res = await request('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', { method: 'GET' });
    return await res.arrayBuffer();
  }

  async function connect() {
    const file = await findFile();
    if (file) saveMeta({ fileId: file.id, fileName: file.name || 'budget.db' });
    else saveMeta({ fileId: '' });
    return file;
  }

  async function debug() {
    const meta = getMeta();
    if (!meta.clientId) throw new Error('No client ID saved.');
    const t = await getToken();
    const res = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(t));
    let info = null;
    try { info = await res.json(); } catch (e) {}
    return { tokenLength: t.length, tokenPrefix: t.slice(0, 8), tokenInfoStatus: res.status, tokenInfo: info };
  }

  window.Drive = {
    getClientId() { return getMeta().clientId; },
    saveClientId(clientId) { cachedToken = null; tokenExpiresAt = 0; saveMeta({ clientId: (clientId || '').trim() }); return getMeta(); },
    isConnected() { return Boolean(getMeta().clientId && getMeta().fileId); },
    status() { const m = getMeta(); return { hasClient: Boolean(m.clientId), hasFile: Boolean(m.fileId), fileName: m.fileName, fileId: m.fileId }; },
    async upload(bytes) { return await uploadBytes(bytes); },
    async connect() { return await connect(); },
    debug,
    async openLatest() {
      const file = await findFile();
      if (!file) throw new Error('No budget.db found in Google Drive.');
      saveMeta({ fileId: file.id, fileName: file.name || 'budget.db' });
      return await downloadFile(file.id);
    }
  };
})();
