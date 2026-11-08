'use strict';
const $ = id => document.getElementById(id);
const api = (path, opts) => Backend.api(path, opts);
const japi = (path, method, body) => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fmt = n => (n === null || n === undefined) ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let categories = [];
let hints = {};
let REVIEW_CAT = 'Needs Review';
let txOffset = 0, txDone = false;
let allocEnvelopes = [], closeGridLoaded = false;
let envDraft = [];
let dataName = 'budget.db';
let appReady = false;
let saveTimer = null;
let driveSyncTimer = null;
let driveSyncBusy = false;
let driveSyncQueued = false;
let suppressDriveSync = false;
let idbPromise = null;
let splitModal, editModal;
let splitTargetId = null;
let editTarget = null;

function openIDB() {
  if (!idbPromise) {
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('budget-local', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return idbPromise;
}

async function idbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly').objectStore('kv').get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbSet(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function scheduleSave() {
  if (!appReady || !Backend.loaded) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await saveNow();
      scheduleDriveSync();
    } catch (e) {
      console.error('autosave failed', e);
    }
  }, 300);
}

Backend.onChange = scheduleSave;

async function saveNow() {
  if (!Backend.loaded) return;
  const bytes = Backend.exportBinary();
  await idbSet('budget.db', bytes);
  await idbSet('meta', { name: dataName, savedAt: Date.now(), bytes: bytes.byteLength });
  await idbSet('name', dataName);
  await updateDataBar();
}

async function updateDataBar() {
  let meta = null;
  try { meta = await idbGet('meta'); } catch {}
  if (!meta) dataName = (await idbGet('name')) || dataName || 'budget.db';
  $('data-name').textContent = dataName;
  $('data-saved').textContent = meta ? 'Saved ' + new Date(meta.savedAt).toLocaleString() : 'Not saved yet';
}

function showLanding() {
  appReady = false;
  $('landing').classList.remove('d-none');
  $('app').classList.add('d-none');
}

function showApp() {
  $('landing').classList.add('d-none');
  $('app').classList.remove('d-none');
}

function landStatus(msg, cls) {
  const el = $('land-status');
  el.textContent = msg || '';
  el.className = 'small mt-3 ' + (cls || 'text-muted');
}

function setSettingsStatus(msg, cls) {
  const el = $('settings-status');
  el.textContent = msg || '';
  el.className = 'small ' + (cls || 'text-muted');
}

function updateDriveStatus(msg, cls) {
  const el = $('drive-status');
  if (msg) {
    el.textContent = msg;
    el.className = 'small ' + (cls || 'text-muted');
    return;
  }
  const s = Drive.status();
  if (!s.hasClient) {
    el.textContent = 'Drive: not connected';
    el.className = 'small text-muted';
  } else if (!Drive.hasToken()) {
    el.textContent = 'Drive: client ID saved — press Connect to enable auto-sync';
    el.className = 'small text-warning';
  } else if (s.hasFile) {
    el.textContent = 'Drive: ' + s.fileName + ' — auto-sync on';
    el.className = 'small text-success';
  } else {
    el.textContent = 'Drive: connected — next change will create budget.db';
    el.className = 'small text-success';
  }
}

function cancelDriveSync() {
  if (driveSyncTimer) {
    clearTimeout(driveSyncTimer);
    driveSyncTimer = null;
  }
}

function scheduleDriveSync() {
  if (suppressDriveSync || !appReady || !Backend.loaded) return;
  const s = Drive.status();
  if (!s.hasClient || !Drive.hasToken()) return;
  cancelDriveSync();
  driveSyncTimer = setTimeout(runDriveSync, 4000);
}

async function runDriveSync() {
  driveSyncTimer = null;
  if (suppressDriveSync || !appReady || !Backend.loaded) return;
  const s = Drive.status();
  if (!s.hasClient || !Drive.hasToken()) return;
  if (driveSyncBusy) {
    driveSyncQueued = true;
    return;
  }
  driveSyncBusy = true;
  try {
    await saveNow();
    await Drive.upload(Backend.exportBinary(), { interactive: false });
    updateDriveStatus('Drive: synced ' + new Date().toLocaleTimeString(), 'text-success');
  } catch (e) {
    updateDriveStatus('Drive auto-sync: ' + e.message, 'text-danger');
  } finally {
    driveSyncBusy = false;
    if (driveSyncQueued) {
      driveSyncQueued = false;
      scheduleDriveSync();
    }
  }
}

function downloadBlob(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadCategories(force) {
  if (!Backend.loaded) return;
  if (categories.length && !force) return;
  categories = await api('/api/categories');
  hints = await api('/api/hints');
  fillCategorySelects();
  updateHintList();
}

function fillCategorySelects() {
  const opts = categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('add-category').innerHTML = opts;
  $('tx-filter-category').innerHTML = '<option value="">All categories</option>' + opts;
  $('pk-envelopes').innerHTML = categories.map(c => `<option value="${esc(c)}">`).join('');
}

function updateHintList() {
  $('hint-list').innerHTML = Object.keys(hints).map(k => `<option value="${esc(k)}">`).join('');
}

function updateReviewName() {
  $('review-name').textContent = REVIEW_CAT;
}

async function loadSummary() {
  await loadCategories();
  const s = await api('/api/summary');
  $('balance').textContent = fmt(s.balance);
  $('review-count').textContent = s.needs_review.length;
  $('envelope-body').innerHTML = s.envelopes.map(e => {
    const cls = e.available !== null && e.available < 0 ? 'over' : '';
    const bal = e.available === null ? '—' : `<span class="${e.available < 0 ? 'neg' : ''}">${fmt(e.available)}</span>`;
    return `<tr class="${cls}"><td>${esc(e.name)}</td><td class="text-end">${bal}</td></tr>`;
  }).join('');
  allocEnvelopes = s.envelopes.filter(e => e.available !== null);
  if (!closeGridLoaded) {
    const avail = {};
    allocEnvelopes.forEach(e => avail[e.name] = e.available);
    buildCloseGrid(avail);
    loadIncomeChecks();
  }
  await loadReview();
}

async function loadIncomeChecks() {
  const pks = await api('/api/paychecks');
  const byName = {};
  pks.forEach(p => { if (!p.is_budget) byName[p.name] = p; });
  const names = Object.keys(byName).sort((a, b) => a.localeCompare(b));
  const sel = $('add-check');
  sel.innerHTML = '<option value="">— choose a saved check —</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel._templates = byName;
}

function buildIncomeGrid(values) {
  if (!allocEnvelopes.length) {
    $('inc-grid').innerHTML = '<div class="col-12 small text-muted">Add categories in Settings first.</div>';
    return;
  }
  const env = allocEnvelopes.map(e => e.name);
  const extra = values ? Object.keys(values).filter(c => !env.includes(c) && Number(values[c]) !== 0) : [];
  const cats = [...env, ...extra.filter((c, i, a) => a.indexOf(c) === i)];
  $('inc-grid').innerHTML = cats.map(name => {
    const v = values && values[name] != null ? Number(values[name]).toFixed(2) : '';
    const note = env.includes(name) ? '' : ' <span class="text-info">(new category)</span>';
    return `<div class="col-6 col-md-4 col-lg-3"><label class="form-label small mb-0">${esc(name)}${note}</label><input type="number" step="0.01" min="0" class="form-control form-control-sm inc-amt" data-cat="${esc(name)}" value="${v}" placeholder="0.00"></div>`;
  }).join('');
  document.querySelectorAll('#inc-grid .inc-amt').forEach(i => i.addEventListener('input', updateIncTotal));
  updateIncTotal();
}

function incValues() {
  return [...document.querySelectorAll('#inc-grid .inc-amt')]
    .map(i => ({ category: i.dataset.cat, amount: Math.round((parseFloat(i.value) || 0) * 100) / 100 }));
}

function updateIncTotal() {
  const amtC = Math.round((parseFloat($('add-amount').value) || 0) * 100);
  const totalC = incValues().reduce((s, a) => s + Math.round(a.amount * 100), 0);
  const el = $('inc-total');
  if (amtC > 0) {
    const remC = amtC - totalC;
    el.textContent = `Split ${fmt(totalC / 100)} of ${fmt(amtC / 100)} — ${fmt(remC / 100)} left`;
    el.className = 'small ' + (remC === 0 ? 'text-success fw-bold' : (remC < 0 ? 'text-danger fw-bold' : 'text-warning'));
  } else {
    el.textContent = '';
    el.className = 'small';
  }
}

function setIncomeMode(on) {
  $('add-check-wrap').classList.toggle('d-none', !on);
  $('add-cat-wrap').classList.toggle('d-none', on);
  $('add-split-panel').classList.toggle('d-none', !on);
  if (on) {
    const sel = $('add-check');
    if (sel.value && sel._templates && sel._templates[sel.value]) {
      const alloc = {};
      sel._templates[sel.value].allocations.forEach(a => alloc[a.category] = a.amount);
      buildIncomeGrid(alloc);
    } else {
      buildIncomeGrid(null);
    }
  }
  updateIncTotal();
}

function buildCloseGrid(avail) {
  $('close-grid').innerHTML = allocEnvelopes.map(e => `
    <div class="col-6 col-md-4 col-lg-3">
      <label class="form-label small mb-0">${esc(e.name)}</label>
      <input type="number" step="0.01" class="form-control form-control-sm close-amt" data-cat="${esc(e.name)}" value="${Number(avail[e.name] || 0).toFixed(2)}">
    </div>`).join('');
  document.querySelectorAll('#close-grid .close-amt').forEach(i => i.addEventListener('input', updateCloseTotal));
  closeGridLoaded = true;
  updateCloseTotal();
}

async function refreshCloseGrid() {
  const s = await api('/api/summary');
  const avail = {};
  s.envelopes.forEach(e => { if (e.available !== null) avail[e.name] = e.available; });
  buildCloseGrid(avail);
}

function updateCloseTotal() {
  const totalC = [...document.querySelectorAll('#close-grid .close-amt')].reduce((s, i) => s + Math.round((parseFloat(i.value) || 0) * 100), 0);
  $('close-total').textContent = 'Total to carry forward: ' + fmt(totalC / 100);
}

async function loadReview() {
  if (!categories.length) await loadCategories();
  const txs = await api('/api/transactions?category=' + encodeURIComponent(REVIEW_CAT) + '&type=expense&limit=500');
  if (!txs.length) {
    $('review-body').innerHTML = '<p class="text-success mb-0">Nothing waiting. Everything is categorized.</p>';
    return;
  }
  $('review-body').innerHTML = `<table class="table table-sm mb-0"><thead><tr><th>Date</th><th>Description</th><th class="text-end">Amount</th><th>Assign to</th></tr></thead><tbody>` +
    txs.map(t => {
      const hint = hints[t.description];
      return `<tr><td>${t.date}</td><td>${esc(t.description)}</td><td class="text-end neg">${fmt(Math.abs(t.amount))}</td>
      <td><select class="form-select form-select-sm review-assign" data-id="${t.id}" style="max-width:170px">${categories.map(c => `<option value="${esc(c)}" ${c === t.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <button class="btn btn-outline-secondary btn-sm ms-1 tx-edit" data-id="${t.id}" data-d="${t.date}" data-n="${esc(t.description)}" data-a="${Math.abs(t.amount)}" data-c="${esc(t.category)}" data-t="expense" data-head="0" title="Edit">✎</button>
      <button class="btn btn-outline-secondary btn-sm ms-1 tx-split" data-id="${t.id}" data-desc="${esc(t.description)}" data-amt="${Math.abs(t.amount)}">Split</button>
      ${hint ? `<button class="btn btn-outline-info btn-sm ms-1 tx-hint" data-id="${t.id}" data-cat="${esc(hint)}" title="Suggested from past purchases">→ ${esc(hint)}</button>` : ''}</td></tr>`;
    }).join('') + '</tbody></table>';
}
async function loadTransactions(reset) {
  if (reset) { txOffset = 0; txDone = false; $('tx-body').innerHTML = ''; }
  if (!Backend.loaded) return;
  await loadCategories();
  const p = new URLSearchParams({ type: $('tx-filter-type').value, limit: 100, offset: txOffset });
  if ($('tx-filter-category').value) p.set('category', $('tx-filter-category').value);
  if ($('tx-search').value) p.set('q', $('tx-search').value);
  if ($('tx-from').value) p.set('date_from', $('tx-from').value);
  if ($('tx-to').value) p.set('date_to', $('tx-to').value);
  const rows = await api('/api/transactions?' + p.toString());
  txOffset += rows.length;
  if (rows.length < 100) txDone = true;

  const inPage = new Set(rows.map(r => r.id));
  const childIds = new Set(rows.filter(r => r.parent_id && inPage.has(r.parent_id)).map(r => r.id));
  const byParent = new Map();
  rows.forEach(r => {
    if (r.parent_id && inPage.has(r.parent_id)) {
      if (!byParent.has(r.parent_id)) byParent.set(r.parent_id, []);
      byParent.get(r.parent_id).push(r);
    }
  });

  const catOpts = c => categories.map(x => `<option value="${esc(x)}" ${x === c ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const rowHtml = t => {
    const sign = t.amount < 0 ? 'neg' : 'pos';
    const parent = t.category === PARENT_MARKER || byParent.has(t.id);
    const hint = hints[t.description];
    const catCell = parent
      ? `<td class="small text-muted">${t.type === 'income' ? 'Income' : 'Split'}</td>`
      : `<td><select class="form-select form-select-sm tx-cat" data-id="${t.id}" style="max-width:160px">${catOpts(t.category)}</select>${t.category === REVIEW_CAT && hint ? `<div class="mt-1"><button class="btn btn-outline-info btn-sm tx-hint" data-id="${t.id}" data-cat="${esc(hint)}" title="Suggested from past purchases">→ ${esc(hint)}</button></div>` : ''}</td>`;
    const editAmt = t.type === 'expense' ? Math.abs(t.amount) : t.amount;
    const canSplit = t.type !== 'allocation' && (parent ? t.type === 'expense' : true);
    const split = canSplit ? `<button class="btn btn-outline-secondary btn-sm tx-split" data-id="${t.id}" data-desc="${esc(t.description)}" data-amt="${Math.abs(t.amount)}">Split</button>` : '';
    const edit = `<button class="btn btn-outline-secondary btn-sm tx-edit" data-id="${t.id}" data-d="${t.date}" data-n="${esc(t.description)}" data-a="${editAmt}" data-c="${parent ? '' : esc(t.category)}" data-t="${t.type}" data-head="${parent ? 1 : 0}" title="Edit">✎</button>`;
    return `<tr><td>${t.date}</td><td>${esc(t.description)}</td>${catCell}<td class="text-end ${sign}">${parent ? '<strong>' + fmt(t.amount) + '</strong>' : fmt(t.amount)}</td><td class="text-end">${edit}${split}<button class="btn btn-outline-danger btn-sm tx-del" data-id="${t.id}">×</button></td></tr>`;
  };
  const childHtml = k => {
    const sign = k.amount < 0 ? 'neg' : 'pos';
    const editAmt = k.type === 'expense' ? Math.abs(k.amount) : k.amount;
    return `<tr class="tx-child"><td></td><td class="ps-4">↳ <span class="text-muted">${esc(k.category)}</span></td><td></td><td class="text-end ${sign}">${fmt(k.amount)}</td><td class="text-end"><button class="btn btn-outline-secondary btn-sm tx-edit" data-id="${k.id}" data-d="${k.date}" data-n="${esc(k.description)}" data-a="${editAmt}" data-c="${esc(k.category)}" data-t="${k.type}" data-head="0" title="Edit">✎</button></td></tr>`;
  };
  const orphanHtml = t => {
    const sign = t.amount < 0 ? 'neg' : 'pos';
    const editAmt = t.type === 'expense' ? Math.abs(t.amount) : t.amount;
    return `<tr class="tx-child"><td>${t.date}</td><td class="ps-4">↳ <span class="text-muted">part of a split not on this page</span></td><td><select class="form-select form-select-sm tx-cat" data-id="${t.id}">${catOpts(t.category)}</select></td><td class="text-end ${sign}">${fmt(t.amount)}</td><td class="text-end"><button class="btn btn-outline-secondary btn-sm tx-edit" data-id="${t.id}" data-d="${t.date}" data-n="${esc(t.description)}" data-a="${editAmt}" data-c="${esc(t.category)}" data-t="${t.type}" data-head="0" title="Edit">✎</button><button class="btn btn-outline-danger btn-sm tx-del" data-id="${t.id}">×</button></td></tr>`;
  };

  let html = '';
  rows.forEach(t => {
    if (childIds.has(t.id)) return;
    if (t.parent_id && !inPage.has(t.parent_id)) { html += orphanHtml(t); return; }
    html += rowHtml(t);
    (byParent.get(t.id) || []).forEach(k => html += childHtml(k));
  });
  $('tx-body').insertAdjacentHTML('beforeend', html);
}

function wireTxBody() {
  $('tx-body').addEventListener('change', async e => {
    const cat = e.target.closest('.tx-cat');
    if (!cat) return;
    try { await japi('/api/transactions/' + cat.dataset.id, 'PATCH', { category: cat.value }); await refreshApp(); } catch (err) { alert(err.message); }
  });
  $('tx-body').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.classList.contains('tx-del')) {
        if (!confirm('Delete this transaction?')) return;
        await japi('/api/transactions/' + btn.dataset.id, 'DELETE');
        await refreshApp();
      }
      if (btn.classList.contains('tx-hint')) {
        await japi('/api/transactions/' + btn.dataset.id, 'PATCH', { category: btn.dataset.cat });
        await refreshApp();
      }
      if (btn.classList.contains('tx-split')) openSplit(btn.dataset.id, btn.dataset.desc, parseFloat(btn.dataset.amt));
      if (btn.classList.contains('tx-edit')) openEdit(btn.dataset.id, btn.dataset);
    } catch (err) { alert(err.message); }
  });
}

function wireReviewBody() {
  $('review-body').addEventListener('change', async e => {
    const sel = e.target.closest('.review-assign');
    if (!sel) return;
    try { await japi('/api/transactions/' + sel.dataset.id, 'PATCH', { category: sel.value }); await refreshApp(); } catch (err) { alert(err.message); }
  });
  $('review-body').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.classList.contains('tx-hint')) {
        await japi('/api/transactions/' + btn.dataset.id, 'PATCH', { category: btn.dataset.cat });
        await refreshApp();
      }
      if (btn.classList.contains('tx-split')) openSplit(btn.dataset.id, btn.dataset.desc, parseFloat(btn.dataset.amt));
      if (btn.classList.contains('tx-edit')) openEdit(btn.dataset.id, btn.dataset);
    } catch (err) { alert(err.message); }
  });
}

let splitTargetAmt = 0;

function splitPartRow(cat, amount) {
  const opts = categories.map(c => `<option value="${esc(c)}" ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  return `<div class="row g-2 mb-2 align-items-end split-row"><div class="col-7"><select class="form-select form-select-sm split-cat">${opts}</select></div><div class="col-4"><input type="number" step="0.01" min="0" class="form-control form-control-sm split-amt" value="${amount ? Number(amount).toFixed(2) : ''}"></div><div class="col-1"><button class="btn btn-outline-danger btn-sm split-rm" type="button">×</button></div></div>`;
}

function splitValues() {
  return [...document.querySelectorAll('#split-parts .split-row')].map(r => ({
    category: r.querySelector('.split-cat').value,
    amount: Math.round((parseFloat(r.querySelector('.split-amt').value) || 0) * 100) / 100
  }));
}

function updateSplitTotal() {
  const totalC = splitValues().reduce((s, p) => s + Math.round(p.amount * 100), 0);
  $('split-total').textContent = fmt(totalC / 100);
}

async function openSplit(id, desc, amt) {
  await loadCategories();
  splitTargetId = id;
  splitTargetAmt = amt;
  $('split-desc').textContent = desc + ' — ' + fmt(amt);
  $('split-target').textContent = fmt(amt);
  const parts = await api('/api/transactions/' + id + '/parts');
  const normalized = (parts.length ? parts : [{ category: REVIEW_CAT, amount: amt }]).map(p => ({
    category: p.category || REVIEW_CAT,
    amount: Math.abs(parseFloat(p.amount) || 0)
  }));
  $('split-parts').innerHTML = normalized.map(p => splitPartRow(p.category, p.amount)).join('');
  updateSplitTotal();
  splitModal.show();
}

async function saveSplit() {
  const parts = splitValues().filter(p => p.amount > 0 && p.category);
  if (!parts.length) { alert('Add at least one part.'); return; }
  try {
    await japi('/api/transactions/' + splitTargetId + '/split', 'POST', { parts });
    splitModal.hide();
    await refreshApp();
  } catch (e) { alert(e.message); }
}

function editPartRow(cat, amount) {
  const opts = categories.map(c => `<option value="${esc(c)}" ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  return `<div class="row g-2 mb-2 align-items-end edit-row"><div class="col-7"><select class="form-select form-select-sm edit-part-cat">${opts}</select></div><div class="col-4"><input type="number" step="0.01" min="0" class="form-control form-control-sm edit-part-amt" value="${amount ? Number(amount).toFixed(2) : ''}"></div><div class="col-1"><button class="btn btn-outline-danger btn-sm edit-part-rm" type="button">×</button></div></div>`;
}

function editValues() {
  return [...document.querySelectorAll('#edit-parts-rows .edit-row')].map(r => ({
    category: r.querySelector('.edit-part-cat').value,
    amount: Math.round((parseFloat(r.querySelector('.edit-part-amt').value) || 0) * 100) / 100
  }));
}

function updateEditPartsTotal() {
  const totalC = editValues().reduce((s, p) => s + Math.round(p.amount * 100), 0);
  $('edit-parts-total').textContent = fmt(totalC / 100);
}

async function openEdit(id, d) {
  await loadCategories();
  editTarget = { id: parseInt(id, 10), type: d.t, head: d.head === '1' };
  $('edit-date').value = d.d;
  $('edit-amount').value = d.a;
  $('edit-desc').value = d.n;
  const isParent = editTarget.head;
  $('edit-cat-wrap').classList.toggle('d-none', isParent);
  if (!isParent) {
    $('edit-cat').innerHTML = categories.map(c => `<option value="${esc(c)}" ${c === d.c ? 'selected' : ''}>${esc(c)}</option>`).join('');
  }
  $('edit-note').textContent = isParent
    ? 'This is a split/income total. Edit the parts below; the total updates automatically.'
    : (editTarget.type === 'allocation' ? 'Allocation — amount may be negative for carryovers.' : 'Expense amounts are stored as negative values.');
  if (isParent) {
    const parts = await api('/api/transactions/' + id + '/parts');
    const normalized = (parts.length ? parts : [{ category: REVIEW_CAT, amount: Math.abs(parseFloat(d.a) || 0) }]).map(p => ({
      category: p.category || REVIEW_CAT,
      amount: Math.abs(parseFloat(p.amount) || 0)
    }));
    $('edit-parts').classList.remove('d-none');
    $('edit-parts-rows').innerHTML = normalized.map(p => editPartRow(p.category, p.amount)).join('');
    updateEditPartsTotal();
  } else {
    $('edit-parts').classList.add('d-none');
    $('edit-parts-rows').innerHTML = '';
  }
  editModal.show();
}

async function saveEdit() {
  if (!editTarget) return;
  const payload = {
    date: $('edit-date').value,
    description: $('edit-desc').value,
    amount: parseFloat($('edit-amount').value)
  };
  if (editTarget.head) {
    const parts = editValues().filter(p => p.amount > 0 && p.category);
    if (!parts.length) { alert('Add at least one part.'); return; }
    payload.parts = parts;
    delete payload.category;
  } else {
    payload.category = $('edit-cat').value;
  }
  try {
    await japi('/api/transactions/' + editTarget.id, 'PATCH', payload);
    editModal.hide();
    await refreshApp();
  } catch (e) { alert(e.message); }
}
const pkBalanceOf = card => parseFloat(card.querySelector('.pk-balance').value) || 0;
const pkAllocInputs = card => [...card.querySelectorAll('.pk-cat-amt')];
const pkAllocCents = i => Math.round((parseFloat(i.value) || 0) * 100);
const pkBalanceCents = card => Math.round(pkBalanceOf(card) * 100);
const pkRowName = i => (i.closest('.pk-row').querySelector('.pk-cat-name').value || '').trim();

const pkRowHTML = (cat, amt) => `<div class="pk-row d-flex align-items-center gap-2 mb-1">
  <input class="form-control form-control-sm flex-grow-1 pk-cat-name" list="pk-envelopes" value="${esc(cat)}">
  <input type="number" step="0.01" min="0" class="form-control form-control-sm pk-cat-amt" style="max-width:110px" value="${Number(amt).toFixed(2)}">
  <button class="btn btn-outline-secondary btn-sm pk-rm-line" title="Remove">×</button>
</div>`;

const pkCollect = card => {
  const allocations = [];
  for (const i of pkAllocInputs(card)) {
    const cat = pkRowName(i);
    const amt = Math.round((parseFloat(i.value) || 0) * 100) / 100;
    if (cat && amt > 0) allocations.push({ category: cat, amount: amt });
  }
  return {
    name: (card.querySelector('.pk-name').value || '').trim(),
    balance: Math.round(pkBalanceOf(card) * 100) / 100,
    allocations
  };
};

function pkCardHTML(pk, isNew) {
  const allocRows = (pk.allocations || []).filter(a => a.amount > 0).map(a => pkRowHTML(a.category, a.amount)).join('');
  return `<div class="col-12 col-md-6">
    <div class="card h-100 pk-card" data-id="${pk.id}">
      <div class="card-body p-3">
        <div class="d-flex justify-content-between align-items-center gap-2 mb-2">
          <input class="form-control form-control-sm fw-bold pk-name" value="${esc(pk.name)}" placeholder="Check name">
          ${isNew ? '' : `<button class="btn btn-outline-danger btn-sm pk-del" data-id="${pk.id}" title="Delete this check">×</button>`}
        </div>
        <div class="mb-2" style="max-width:220px">
          <label class="form-label small mb-0">Amount</label>
          <input type="number" step="0.01" min="0.01" class="form-control form-control-sm pk-balance" value="${pk.balance ? Number(pk.balance).toFixed(2) : ''}" placeholder="0.00">
        </div>
        <label class="form-label small mb-1">Category split</label>
        <div class="pk-allocs mb-1">${allocRows}</div>
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-1 mb-2">
          <span class="small pk-sum"></span>
          <button class="btn btn-outline-warning btn-sm pk-scale d-none" title="Scale every envelope proportionally to the new amount">Scale to new amount</button>
        </div>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="small text-muted">New category:</span>
          <input class="form-control form-control-sm pk-add-name" list="pk-envelopes" style="max-width:170px" placeholder="type name…">
          <button class="btn btn-outline-secondary btn-sm pk-add-btn" type="button">+ Add row</button>
          <div class="ms-auto d-flex align-items-center gap-2">
            <span class="small pk-status"></span>
            <button class="btn btn-success btn-sm ${isNew ? 'pk-create' : 'pk-save'}" type="button">${isNew ? 'Create' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function pkSyncAllocHint(card) {
  const wrap = card.querySelector('.pk-allocs');
  let hint = wrap.querySelector('.pk-no-allocs');
  if (pkAllocInputs(card).length === 0) {
    if (!hint) {
      hint = document.createElement('p');
      hint.className = 'pk-no-allocs text-muted small mb-1';
      hint.textContent = 'No envelopes yet — add some below.';
      wrap.appendChild(hint);
    }
  } else if (hint) hint.remove();
}

function pkAddRow(card, cat) {
  cat = (cat || '').trim();
  if (!cat) return;
  const row = document.createElement('div');
  row.innerHTML = pkRowHTML(cat, 0);
  card.querySelector('.pk-allocs').appendChild(row.firstElementChild);
  pkSyncAllocHint(card);
  pkUpdateSum(card);
}

function pkUpdateSum(card) {
  const balC = pkBalanceCents(card);
  let totC = 0;
  for (const i of pkAllocInputs(card)) {
    const row = i.closest('.pk-row');
    const name = pkRowName(i);
    const amtC = pkAllocCents(i);
    row.classList.toggle('pk-unnamed', amtC > 0 && !name);
    if (name) totC += amtC;
  }
  const remC = balC - totC;
  const el = card.querySelector('.pk-sum');
  const sc = card.querySelector('.pk-scale');
  if (balC > 0) {
    el.textContent = `Assigned ${fmt(totC / 100)} of ${fmt(balC / 100)} — ${fmt(remC / 100)} left`;
    el.className = 'small pk-sum ' + (remC === 0 ? 'text-success fw-bold' : (remC < 0 ? 'text-danger fw-bold' : 'text-warning'));
    sc.classList.toggle('d-none', !(pkAllocInputs(card).length && remC !== 0));
  } else {
    el.textContent = '';
    el.className = 'small pk-sum';
    sc.classList.add('d-none');
  }
  pkBudgetLive();
}

function pkBudgetLive() {
  const wrap = $('pk-budget');
  if (!wrap) return;
  const totals = {};
  for (const card of document.querySelectorAll('#paycheck-cards .pk-card')) {
    if (!card.dataset.id) continue;
    const balC = pkBalanceCents(card);
    if (!balC) continue;
    for (const i of pkAllocInputs(card)) {
      const name = pkRowName(i);
      const amtC = pkAllocCents(i);
      if (name && amtC > 0) totals[name] = (totals[name] || 0) + amtC / 100;
    }
  }
  wrap.innerHTML = pkBudgetCardHTML(totals);
}

function pkBudgetCardHTML(totals) {
  const grand = Object.values(totals).reduce((s, v) => s + v, 0) || 0;
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  return `<div class="card border-info">
    <div class="card-body p-3">
      <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
        <h6 class="mb-0">Monthly Budget <span class="text-muted small fw-normal">— total of all checks, by category</span></h6>
        <span class="badge bg-info fs-6">${fmt(grand)}</span>
      </div>
      ${rows.length ? rows.map(([cat, amt]) => `<div class="d-flex justify-content-between align-items-center small border-bottom border-opacity-25 py-1"><span>${esc(cat)}</span><span class="fw-semibold">${fmt(amt)}</span></div>`).join('') : '<p class="text-muted small mb-0">No category amounts yet.</p>'}
      <p class="text-muted small mb-0 mt-2">Updates live as you edit the checks below.</p>
    </div>
  </div>`;
}

function pkScale(card) {
  const inputs = [...pkAllocInputs(card)].filter(i => pkRowName(i) && pkAllocCents(i) > 0);
  const cents = inputs.map(i => pkAllocCents(i));
  const totalCents = cents.reduce((s, c) => s + c, 0);
  const targetCents = pkBalanceCents(card);
  if (totalCents <= 0 || targetCents <= 0) return;
  const scaled = cents.map(c => Math.floor(c * targetCents / totalCents));
  let rem = targetCents - scaled.reduce((s, v) => s + v, 0);
  const order = cents.map((c, i) => i).sort((a, b) => cents[b] - cents[a]);
  let k = 0;
  while (rem > 0) { scaled[order[k % order.length]] += 1; rem -= 1; k += 1; }
  inputs.forEach((inp, idx) => inp.value = (scaled[idx] / 100).toFixed(2));
  pkUpdateSum(card);
}

function pkStatus(st, type, msg) {
  st.textContent = msg || '';
  st.classList.remove('text-success', 'text-danger');
  if (type) st.classList.add(type);
}

async function pkDelete(card) {
  const id = card.dataset.id;
  const st = card.querySelector('.pk-status');
  if (!confirm('Delete this check template? Envelope balances keep their current totals.')) return;
  const btn = card.querySelector('.pk-del');
  btn.disabled = true;
  try {
    await api('/api/paychecks/' + id, { method: 'DELETE' });
    await loadPaychecks();
    await loadIncomeChecks();
  } catch (e) {
    pkStatus(st, 'text-danger', e.message);
    btn.disabled = false;
  }
}

async function pkSave(card) {
  const st = card.querySelector('.pk-status');
  const btn = card.querySelector('.pk-save');
  pkStatus(st, null, '');
  const data = pkCollect(card);
  const balC = Math.round(data.balance * 100);
  const totC = data.allocations.reduce((s, a) => s + Math.round(a.amount * 100), 0);
  if (!data.name) { pkStatus(st, 'text-danger', 'Name required.'); pkUpdateSum(card); return; }
  if (balC <= 0) { pkStatus(st, 'text-danger', 'Enter an amount.'); pkUpdateSum(card); return; }
  if (balC !== totC) {
    const unnamedCents = [...pkAllocInputs(card)].reduce((s, i) => (pkRowName(i) ? s : s + Math.max(0, pkAllocCents(i))), 0);
    if (unnamedCents > 0) {
      pkStatus(st, 'text-danger', `Enter a category for ${fmt(unnamedCents / 100)} of unassigned amounts.`);
      pkUpdateSum(card);
      return;
    }
    const diff = Math.abs(totC - balC) / 100;
    const over = totC > balC;
    pkStatus(st, 'text-danger', `The split is ${fmt(diff)} ${over ? 'over' : 'short'} — ${fmt(totC / 100)} assigned of ${fmt(data.balance)}. The split must equal the amount.`);
    pkUpdateSum(card);
    return;
  }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await japi('/api/paychecks/' + card.dataset.id, 'PATCH', data);
    pkStatus(st, 'text-success', 'Saved.');
    await loadPaychecks();
    await loadIncomeChecks();
  } catch (e) {
    pkStatus(st, 'text-danger', e.message);
    pkUpdateSum(card);
  } finally {
    const fresh = document.querySelector(`.pk-card[data-id="${card.dataset.id}"] .pk-save`);
    if (fresh) { fresh.disabled = false; fresh.textContent = 'Save'; }
    const freshCreate = document.querySelector(`.pk-card[data-id="${card.dataset.id}"] .pk-create`);
    if (freshCreate) { freshCreate.disabled = false; freshCreate.textContent = 'Create'; }
  }
}

async function pkCreate(card) {
  const st = card.querySelector('.pk-status');
  const btn = card.querySelector('.pk-create');
  pkStatus(st, null, '');
  const data = pkCollect(card);
  const balC = Math.round(data.balance * 100);
  const totC = data.allocations.reduce((s, a) => s + Math.round(a.amount * 100), 0);
  if (!data.name) { pkStatus(st, 'text-danger', 'Name required.'); pkUpdateSum(card); return; }
  if (balC <= 0) { pkStatus(st, 'text-danger', 'Enter an amount.'); pkUpdateSum(card); return; }
  if (balC !== totC) {
    const unnamedCents = [...pkAllocInputs(card)].reduce((s, i) => (pkRowName(i) ? s : s + Math.max(0, pkAllocCents(i))), 0);
    if (unnamedCents > 0) {
      pkStatus(st, 'text-danger', `Enter a category for ${fmt(unnamedCents / 100)} of unassigned amounts.`);
      pkUpdateSum(card);
      return;
    }
    const diff = Math.abs(totC - balC) / 100;
    const over = totC > balC;
    pkStatus(st, 'text-danger', `The split is ${fmt(diff)} ${over ? 'short' : 'over'} — ${fmt(totC / 100)} assigned of ${fmt(data.balance)}. The split must equal the amount.`);
    pkUpdateSum(card);
    return;
  }
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    await japi('/api/paychecks', 'POST', data);
    pkStatus(st, 'text-success', 'Created.');
    await loadPaychecks();
    await loadIncomeChecks();
  } catch (e) {
    pkStatus(st, 'text-danger', e.message);
    pkUpdateSum(card);
  } finally {
    const fresh = document.querySelector(`.pk-card[data-id="${card.dataset.id}"] .pk-create`);
    if (fresh) { fresh.disabled = false; fresh.textContent = 'Create'; }
  }
}

async function loadPaychecks() {
  const pks = await api('/api/paychecks');
  const income = pks.filter(p => !p.is_budget);
  const totals = {};
  for (const p of income) for (const a of (p.allocations || [])) {
    if (a.amount > 0) totals[a.category] = (totals[a.category] || 0) + a.amount;
  }
  let html = `<div class="col-12" id="pk-budget">${pkBudgetCardHTML(totals)}</div>`;
  if (!income.length) {
    html += `<div class="col-12"><div class="card"><div class="card-body text-center small text-muted py-4">No checks saved yet. Add income with the form at the top (Type = Income) and it will be remembered here — or click "+ New check" to create a reusable template.</div></div></div>`;
  } else {
    html += income.map(pk => pkCardHTML(pk, false)).join('');
  }
  $('paycheck-cards').innerHTML = html;
  document.querySelectorAll('#paycheck-cards .pk-card').forEach(card => { pkSyncAllocHint(card); pkUpdateSum(card); });
}

async function loadReport() {
  const m = $('report-month').value;
  if (!m) return;
  const s = await api('/api/report?month=' + encodeURIComponent(m));
  const rows = amts => amts.length
    ? amts.map(x => `<tr><td>${esc(x.category || x.name || '')}</td><td class="text-end">${fmt(x.amount)}</td></tr>`).join('')
    : '<tr><td class="text-muted" colspan="2">None.</td></tr>';
  $('report-body').innerHTML = `<div class="row g-3">
    <div class="col-md-6"><div class="card h-100"><div class="card-body">
      <h6 class="mb-1">Income received <span class="badge bg-success">${fmt(s.received)}</span></h6>
      <p class="text-muted small mb-2">Planned from check templates: ${fmt(s.planned)}</p>
      <table class="table table-sm mb-0"><tbody>${rows(s.income_detail.map(d => ({ name: d.name + (d.count > 1 ? ` (x${d.count})` : ''), amount: d.amount })))}</tbody></table>
    </div></div></div>
    <div class="col-md-6"><div class="card h-100"><div class="card-body">
      <h6 class="mb-1">Spent <span class="badge bg-danger">${fmt(s.spent)}</span></h6>
      <p class="text-muted small mb-2">Net this month <span class="${s.net < 0 ? 'neg' : ''}">${fmt(s.net)}</span></p>
      <table class="table table-sm mb-0"><tbody>${rows(s.expenses)}</tbody></table>
    </div></div></div>
  </div>`;
}

function renderEnvChips() {
  $('env-chips').innerHTML = envDraft.length
    ? envDraft.map((c, i) => `<span class="badge bg-light text-dark border me-1 mb-1">${esc(c)} <button type="button" class="btn btn-sm p-0 ms-1 env-rm" data-i="${i}" title="Remove">×</button></span>`).join('')
    : '<span class="text-muted small">No categories yet.</span>';
}

async function loadSettings() {
  const cfg = await api('/api/config');
  envDraft = [...(cfg.envelopes || [])];
  $('review-cat').value = cfg.review_category || 'Needs Review';
  $('drive-client').value = Drive.getClientId() || '';
  renderEnvChips();
  updateDriveStatus();
}

async function saveConfigPatch(patch) {
  await japi('/api/config', 'POST', patch);
  const cfg = await api('/api/config');
  REVIEW_CAT = cfg.review_category || 'Needs Review';
  updateReviewName();
  await loadCategories(true);
  await refreshApp();
}

function setCloseStatus(msg, cls) {
  $('close-status').textContent = msg || '';
  $('close-status').className = 'small ' + (cls || 'text-muted');
}

async function refreshApp() {
  if (!appReady || !Backend.loaded) return;
  await loadSummary();
  await loadIncomeChecks();
  if (!$('tab-transactions').classList.contains('d-none')) await loadTransactions(true);
  if (!$('tab-paychecks').classList.contains('d-none')) await loadPaychecks();
  if (!$('tab-report').classList.contains('d-none') && $('report-month').value) await loadReport();
  if (!$('tab-settings').classList.contains('d-none')) await loadSettings();
  await updateDriveStatus();
  await updateDataBar();
}

async function enterApp() {
  appReady = true;
  await loadCategories(true);
  const cfg = await api('/api/config');
  REVIEW_CAT = cfg.review_category || 'Needs Review';
  updateReviewName();
  await saveNow();
  await updateDataBar();
  showApp();
  await refreshApp();
}

async function createBudget() {
  try {
    landStatus('Creating…');
    await Backend.createFresh();
    dataName = 'budget.db';
    await saveNow();
    await enterApp();
  } catch (e) { landStatus(e.message, 'text-danger'); }
}

async function openFile(file) {
  cancelDriveSync();
  suppressDriveSync = true;
  try {
    landStatus('Opening…');
    await Backend.loadFromBinary(new Uint8Array(await file.arrayBuffer()));
    dataName = file.name || 'budget.db';
    await saveNow();
    await enterApp();
  } catch (e) { landStatus(e.message, 'text-danger'); }
  finally { suppressDriveSync = false; }
}

async function openDrive() {
  if (!Drive.status().hasClient) {
    landStatus('No Google OAuth client ID saved. Open or create a budget first, then save the client ID in Settings, then retry.', 'text-warning');
    return;
  }
  cancelDriveSync();
  suppressDriveSync = true;
  try {
    landStatus('Contacting Google Drive…');
    const bytes = await Drive.openLatest();
    await Backend.loadFromBinary(new Uint8Array(bytes));
    dataName = 'budget.db';
    await saveNow();
    await enterApp();
  } catch (e) { landStatus(e.message, 'text-danger'); }
  finally { suppressDriveSync = false; }
}

async function newBudget() {
  if (!confirm('Replace the current budget with a fresh empty one? The current data will be lost unless saved or downloaded.')) return;
  cancelDriveSync();
  suppressDriveSync = true;
  try {
    await saveNow();
    await Backend.createFresh();
    dataName = 'budget.db';
    await saveNow();
    await enterApp();
  } catch (e) { alert(e.message); }
  finally { suppressDriveSync = false; }
}

async function downloadBackend() {
  if (!Backend.loaded) return;
  await saveNow();
  downloadBlob(Backend.exportBinary(), dataName);
}

async function reloadSaved() {
  cancelDriveSync();
  suppressDriveSync = true;
  try {
    const bytes = await idbGet('budget.db');
    if (!bytes) { alert('Nothing saved in this browser yet.'); return; }
    await Backend.loadFromBinary(new Uint8Array(bytes));
    await saveNow();
    await enterApp();
  } catch (e) { alert(e.message); }
  finally { suppressDriveSync = false; }
}
let txSearchTimer = null;

function localDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function localMonth() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1);
}

function addSplitPart() {
  $('split-parts').insertAdjacentHTML('beforeend', splitPartRow(categories[0] || '', ''));
  updateSplitTotal();
}

function addEditPart() {
  $('edit-parts-rows').insertAdjacentHTML('beforeend', editPartRow(categories[0] || '', ''));
  updateEditPartsTotal();
}

function addPaycheck() {
  const html = pkCardHTML({ id: '', name: '', balance: 0, allocations: [] }, true);
  const budget = $('pk-budget');
  if (budget) budget.insertAdjacentHTML('afterend', html);
  else $('paycheck-cards').insertAdjacentHTML('beforeend', html);
  const card = document.querySelector('#paycheck-cards .pk-card[data-id=""]');
  if (card) {
    pkSyncAllocHint(card);
    pkUpdateSum(card);
    card.querySelector('.pk-name').focus();
  }
}

function envAdd() {
  const v = $('env-new').value.trim();
  if (!v) return;
  envDraft.push(v);
  $('env-new').value = '';
  renderEnvChips();
}

splitModal = new bootstrap.Modal($('split-modal'));
editModal = new bootstrap.Modal($('edit-modal'));

$('add-date').value = localDate();
$('close-date').value = localDate();
$('report-month').value = localMonth();

document.querySelectorAll('.nav-tabs .nav-link').forEach(a => {
  a.addEventListener('click', async e => {
    e.preventDefault();
    document.querySelectorAll('.nav-tabs .nav-link').forEach(x => x.classList.remove('active'));
    a.classList.add('active');
    ['categories', 'transactions', 'review', 'paychecks', 'report', 'settings'].forEach(t => {
      const el = $('tab-' + t);
      if (el) el.classList.toggle('d-none', t !== a.dataset.tab);
    });
    $('add-panel').classList.toggle('d-none', a.dataset.tab !== 'transactions');
    try {
      if (a.dataset.tab === 'transactions') { await loadTransactions(true); await loadIncomeChecks(); }
      if (a.dataset.tab === 'paychecks') { await loadPaychecks(); await loadIncomeChecks(); }
      if (a.dataset.tab === 'review') await loadReview();
      if (a.dataset.tab === 'report') { if ($('report-month').value) await loadReport(); }
      if (a.dataset.tab === 'settings') await loadSettings();
    } catch (err) { alert(err.message); }
  });
});

$('land-create').addEventListener('click', createBudget);
$('land-open-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => {
  if (e.target.files[0]) openFile(e.target.files[0]);
  e.target.value = '';
});
$('land-open-drive').addEventListener('click', openDrive);

$('data-save').addEventListener('click', () => saveNow().catch(e => alert(e.message)));
$('data-reload').addEventListener('click', reloadSaved);
$('data-download').addEventListener('click', downloadBackend);
$('data-drive').addEventListener('click', () => document.querySelector('[data-tab="settings"]').click());
$('period-btn').addEventListener('click', () => {
  $('tab-allocate').classList.toggle('d-none');
  if (!$('tab-allocate').classList.contains('d-none') && !closeGridLoaded) refreshCloseGrid().catch(e => alert(e.message));
});

$('close-load').addEventListener('click', async () => {
  try {
    setCloseStatus('Loading current balances…', 'text-muted');
    await refreshCloseGrid();
    setCloseStatus('', 'text-muted');
  } catch (e) { setCloseStatus(e.message, 'text-danger'); }
});

$('close-form').addEventListener('submit', async e => {
  e.preventDefault();
  const amounts = {};
  document.querySelectorAll('#close-grid .close-amt').forEach(i => {
    const v = Math.round((parseFloat(i.value) || 0) * 100) / 100;
    if (v > 0) amounts[i.dataset.cat] = v;
  });
  if (!Object.keys(amounts).length) { setCloseStatus('Nothing to carry forward.', 'text-warning'); return; }
  if (!confirm('Close the period? This clears previous transaction detail and keeps only the carryover balances above.')) return;
  cancelDriveSync();
  suppressDriveSync = true;
  try {
    setCloseStatus('Saving local backup…', 'text-muted');
    await saveNow();
    if (Drive.status().hasClient) {
      setCloseStatus('Uploading period backup to Google Drive…', 'text-muted');
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        await Drive.backup('budget-backup-' + stamp + '.db', Backend.exportBinary());
      } catch (err) {
        if (!confirm('Google Drive backup failed: ' + err.message + '\n\nClose the period anyway without a Drive backup?')) { suppressDriveSync = false; return; }
      }
    }
    setCloseStatus('Closing…', 'text-muted');
    await japi('/api/period/close', 'POST', { date: $('close-date').value, amounts });
    closeGridLoaded = false;
    $('close-grid').innerHTML = '';
    await refreshApp();
    $('tab-allocate').classList.add('d-none');
    setCloseStatus('Closed. A fresh period started.', 'text-success');
    suppressDriveSync = false;
    scheduleDriveSync();
  } catch (err) {
    suppressDriveSync = false;
    setCloseStatus(err.message, 'text-danger');
  }
});

$('add-type').addEventListener('change', () => {
  const on = $('add-type').value === 'income';
  setIncomeMode(on);
  $('add-status').textContent = '';
  $('add-status').className = 'small';
  if (on) {
    if (!$('add-check').value) buildIncomeGrid(null);
  } else {
    $('add-check').value = '';
    buildIncomeGrid(null);
  }
});

$('add-check').addEventListener('change', () => {
  $('add-status').textContent = '';
  $('add-status').className = 'small';
  const sel = $('add-check').value;
  if (sel === '') { buildIncomeGrid(null); return; }
  const tpl = ($('add-check')._templates || {})[sel];
  if (!tpl) { buildIncomeGrid(null); return; }
  $('add-desc').value = tpl.name;
  $('add-amount').value = Number(tpl.balance).toFixed(2);
  const byCat = {};
  tpl.allocations.forEach(a => { byCat[a.category] = a.amount || 0; });
  buildIncomeGrid(byCat);
  updateIncTotal();
});

$('add-amount').addEventListener('input', updateIncTotal);

$('add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const status = $('add-status');
  const date = $('add-date').value;
  const desc = $('add-desc').value.trim();
  const amount = Math.round((parseFloat($('add-amount').value) || 0) * 100) / 100;
  if (!date || !desc || amount <= 0) {
    status.textContent = 'Enter a date, description, and amount.';
    status.className = 'small text-danger';
    return;
  }
  status.textContent = 'Saving…';
  status.className = 'small';
  try {
    if ($('add-type').value === 'income') {
      const allocations = incValues().filter(a => a.amount > 0 && a.category);
      const total = allocations.reduce((s, a) => s + Math.round(a.amount * 100), 0) / 100;
      if (total !== amount) {
        status.textContent = 'The income split must equal the amount (' + fmt(total) + ' of ' + fmt(amount) + ').';
        status.className = 'small text-danger';
        return;
      }
      await japi('/api/income', 'POST', { name: desc, date, amount, allocations });
    } else {
      await japi('/api/transactions', 'POST', { date, description: desc, amount, category: $('add-category').value, type: 'expense' });
    }
    const wasIncome = $('add-type').value === 'income';
    $('add-desc').value = '';
    $('add-amount').value = '';
    $('add-check').value = '';
    if (wasIncome) { buildIncomeGrid(null); updateIncTotal(); }
    status.textContent = 'Added.';
    status.className = 'small text-success';
    await refreshApp();
  } catch (err) {
    status.textContent = err.message;
    status.className = 'small text-danger';
  }
});

['tx-filter-type', 'tx-filter-category', 'tx-from', 'tx-to'].forEach(id => {
  $(id).addEventListener('change', () => loadTransactions(true).catch(err => alert(err.message)));
});
$('tx-search').addEventListener('input', () => {
  clearTimeout(txSearchTimer);
  txSearchTimer = setTimeout(() => loadTransactions(true).catch(err => alert(err.message)), 300);
});
$('tx-more').addEventListener('click', async () => {
  if (!txDone) await loadTransactions(false).catch(err => alert(err.message));
});

$('split-add-part').addEventListener('click', addSplitPart);
$('split-save').addEventListener('click', saveSplit);
$('split-parts').addEventListener('input', updateSplitTotal);
$('split-parts').addEventListener('click', e => {
  const rm = e.target.closest('.split-rm');
  if (rm) { rm.closest('.split-row').remove(); updateSplitTotal(); }
});

$('edit-add-part').addEventListener('click', addEditPart);
$('edit-save').addEventListener('click', saveEdit);
$('edit-parts-rows').addEventListener('input', updateEditPartsTotal);
$('edit-parts-rows').addEventListener('click', e => {
  const rm = e.target.closest('.edit-part-rm');
  if (rm) { rm.closest('.edit-row').remove(); updateEditPartsTotal(); }
});

$('pk-new').addEventListener('click', addPaycheck);
$('paycheck-cards').addEventListener('input', e => {
  const inp = e.target.closest('.pk-balance, .pk-cat-amt, .pk-cat-name');
  if (!inp) return;
  const card = inp.closest('.pk-card');
  if (card) pkUpdateSum(card);
});
$('paycheck-cards').addEventListener('click', async e => {
  const card = e.target.closest('.pk-card');
  if (!card) return;
  if (e.target.closest('.pk-add-btn')) {
    pkAddRow(card, card.querySelector('.pk-add-name').value);
    card.querySelector('.pk-add-name').value = '';
    return;
  }
  if (e.target.closest('.pk-rm-line')) {
    e.target.closest('.pk-row').remove();
    pkSyncAllocHint(card);
    pkUpdateSum(card);
    return;
  }
  if (e.target.closest('.pk-scale')) { pkScale(card); return; }
  if (e.target.closest('.pk-del')) { pkDelete(card); return; }
  if (e.target.closest('.pk-save')) { pkSave(card); return; }
  if (e.target.closest('.pk-create')) { pkCreate(card); return; }
});
$('paycheck-cards').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.target.type !== 'text') return;
  const card = e.target.closest('.pk-card');
  if (!card) return;
  if (e.target.classList.contains('pk-add-name')) {
    e.preventDefault();
    pkAddRow(card, e.target.value);
    e.target.value = '';
  }
});

$('report-month').addEventListener('change', () => { if ($('report-month').value) loadReport().catch(err => alert(err.message)); });

$('env-add').addEventListener('click', envAdd);
$('env-new').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); envAdd(); }
});
$('env-chips').addEventListener('click', e => {
  const rm = e.target.closest('.env-rm');
  if (rm) { envDraft.splice(parseInt(rm.dataset.i, 10), 1); renderEnvChips(); }
});
$('settings-save').addEventListener('click', async () => {
  try {
    setSettingsStatus('Saving…');
    await saveConfigPatch({ envelopes: envDraft, review_category: $('review-cat').value.trim() || 'Needs Review' });
    setSettingsStatus('Saved.', 'text-success');
  } catch (e) { setSettingsStatus(e.message, 'text-danger'); }
});

$('drive-save-client').addEventListener('click', () => {
  cancelDriveSync();
  Drive.saveClientId($('drive-client').value.trim());
  updateDriveStatus('Client ID saved.', 'text-success');
});
$('drive-connect').addEventListener('click', async () => {
  if (!Drive.status().hasClient) { updateDriveStatus('Save a client ID first.', 'text-warning'); return; }
  cancelDriveSync();
  updateDriveStatus('Connecting…');
  try {
    const file = await Drive.connect();
    updateDriveStatus(file ? 'Drive: ' + (file.name || 'budget.db') + ' — auto-sync on' : 'Drive: connected — next change will create budget.db', 'text-success');
  } catch (e) { updateDriveStatus(e.message, 'text-danger'); }
});
$('drive-open').addEventListener('click', async () => {
  if (!Drive.status().hasClient) { updateDriveStatus('Save a client ID first.', 'text-warning'); return; }
  cancelDriveSync();
  suppressDriveSync = true;
  updateDriveStatus('Opening latest…');
  try {
    const bytes = await Drive.openLatest();
    await Backend.loadFromBinary(new Uint8Array(bytes));
    dataName = 'budget.db';
    await saveNow();
    await enterApp();
    updateDriveStatus();
  } catch (e) { updateDriveStatus(e.message, 'text-danger'); }
  finally { suppressDriveSync = false; }
});
$('drive-upload').addEventListener('click', async () => {
  if (!Backend.loaded) { updateDriveStatus('No budget loaded.', 'text-warning'); return; }
  cancelDriveSync();
  updateDriveStatus('Uploading…');
  try {
    const m = await Drive.upload(Backend.exportBinary());
    updateDriveStatus('Uploaded ' + (m.fileName || 'budget.db') + ' — auto-sync on', 'text-success');
  } catch (e) { updateDriveStatus(e.message, 'text-danger'); }
});

$('data-save2').addEventListener('click', () => saveNow().catch(e => alert(e.message)));
$('data-reload2').addEventListener('click', reloadSaved);
$('data-download2').addEventListener('click', downloadBackend);
$('data-new').addEventListener('click', newBudget);

window.addEventListener('pagehide', () => {
  if (appReady) saveNow().catch(e => console.error(e));
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && appReady) saveNow().catch(e => console.error(e));
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js?v=5', { updateViaCache: 'none' }).catch(() => {});
  });
}

(async () => {
  try {
    await Backend.init();
    const saved = await idbGet('budget.db');
    if (saved && saved.byteLength > 0) {
      const meta = await idbGet('meta');
      dataName = (meta && meta.name) || (await idbGet('name')) || 'budget.db';
      await Backend.loadFromBinary(saved);
      await enterApp();
    } else {
      showLanding();
    }
  } catch (err) {
    console.error(err);
    showLanding();
    landStatus(err.message, 'text-danger');
  }
})();
