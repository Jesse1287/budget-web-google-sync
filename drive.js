(function () {
  const CLIENT_KEY = 'budget.drive.client_id';
  const FILE_ID_KEY = 'budget.drive.file_id';
  const FILE_NAME_KEY = 'budget.drive.file_name';
  const API_FILES = 'https://www.googleapis.com/drive/v3/files';
  let authPromise = null;

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
    await loadScript();
    if (!authPromise) {
      authPromise = window.google.accounts.oauth2.initTokenClient({
        client_id: meta.clientId,
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: () => {}
      }).requestAccessToken();
      authPromise = authPromise.catch(err => { authPromise = null; throw err; });
    }
    const res = await authPromise;
    authPromise = null;
    return res.access_token;
  }

  async function request(path, options) {
    const token = await getToken();
    const res = await fetch(path, Object.assign({}, options, {
      headers: Object.assign({ Authorization: 'Bearer ' + token }, options && options.headers)
    }));
    if (!res.ok) {
      let msg = res.statusText;
      try { const e = await res.json(); msg = e.error && e.error.message ? e.error.message : msg; } catch {}
      throw new Error('Google Drive: ' + msg);
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
      const res = await request('https://www.googleapis.com/upload/drive/v3/files/' + fileId, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const data = await res.json();
      saveMeta({ fileId: data.id, fileName: data.name || 'budget.db' });
      return { fileId: data.id, fileName: data.name || 'budget.db' };
    }
    const boundary = 'budget' + Date.now();
    const metaJson = JSON.stringify({ name: 'budget.db', mimeType: 'application/octet-stream' });
    const blobPart1 = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`], { type: '' });
    const blobPart2 = new Blob([`--${boundary}--\r\n`], { type: '' });
    const blob = new Blob([blobPart1, file, blobPart2], { type: `multipart/related; boundary=${boundary}` });
    const res = await request(API_FILES + '?uploadType=multipart', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: blob });
    const data = await res.json();
    saveMeta({ fileId: data.id, fileName: data.name || 'budget.db' });
    return { fileId: data.id, fileName: data.name || 'budget.db' };
  }

  async function downloadFile(id) {
    const res = await request('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media', { method: 'GET' });
    return await res.arrayBuffer();
  }

  async function connect() {
    const params = new URLSearchParams({ q: "name='budget.db' and trashed=false", fields: 'files(id,name,modifiedTime)', pageSize: '10', orderBy: 'modifiedTime desc' });
    await request(API_FILES + '?' + params.toString());
    const file = await findFile();
    if (file) saveMeta({ fileId: file.id, fileName: file.name || 'budget.db' });
    return file;
  }

  window.Drive = {
    getClientId() { return getMeta().clientId; },
    saveClientId(clientId) { saveMeta({ clientId: (clientId || '').trim() }); return getMeta(); },
    isConnected() { return Boolean(getMeta().clientId && getMeta().fileId); },
    status() { const m = getMeta(); return { hasClient: Boolean(m.clientId), hasFile: Boolean(m.fileId), fileName: m.fileName, fileId: m.fileId }; },
    async upload(bytes) { return await uploadBytes(bytes); },
    async connect() { return await connect(); },
    async openLatest() {
      const file = await findFile();
      if (!file) throw new Error('No budget.db found in Google Drive.');
      saveMeta({ fileId: file.id, fileName: file.name || 'budget.db' });
      return await downloadFile(file.id);
    }
  };
})();
