// backend.js — in-browser data layer (a port of reference/app.py onto SQL.js).
// No server: the whole database lives in memory; app.js calls Backend.api(path, opts)
// exactly like it called fetch(). Every mutation is auto-saved by app.js after each
// call, so a typo fix recalculates balances/reports immediately and persists.
'use strict';

const PARENT_MARKER = '__split__';
const DEFAULT_REVIEW = 'Needs Review';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS paychecks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    balance REAL NOT NULL,
    is_budget INTEGER NOT NULL DEFAULT 0,
    date TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('expense', 'income', 'allocation')),
    source TEXT NOT NULL DEFAULT 'manual',
    paycheck_id INTEGER REFERENCES paychecks(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS paycheck_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paycheck_id INTEGER NOT NULL REFERENCES paychecks(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    amount REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS app_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_cat ON transactions(category);
CREATE INDEX IF NOT EXISTS idx_txn_dedup ON transactions(date, description, amount, category, type, source);
`;

function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }
function todayISO() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function nowISO() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }

const Backend = {
    SQL: null,
    DB: null,
    fileName: 'budget.db',
    loaded: false,
    onChange: null, // app.js sets this: called after every mutation (drives auto-save)

    async init() {
        // index.html sets window.SQLJS_BASE to the SQL.js CDN base (e.g. cdnjs 1.10.0)
        // so locateFile resolves the wasm against it. Fallback keeps it working if unset.
        const base = (typeof SQLJS_BASE !== 'undefined' && SQLJS_BASE) ? SQLJS_BASE : 'sql.js/';
        this.SQL = await initSqlJs({ locateFile: (f) => base + f });
    },

    // ---- persistence ----
    async loadFromBinary(bytes) {
        if (!this.SQL) await this.init();
        this.DB = new this.SQL.Database(new Uint8Array(bytes));
        this._migrate();
        this.loaded = true;
    },

    createFresh() {
        if (!this.SQL) throw new Error('SQL.js not initialized');
        this.DB = new this.SQL.Database();
        this.DB.run('PRAGMA foreign_keys = ON;');
        this._runSchema();
        this._ensureConfig();
        this.loaded = true;
    },

    exportBinary() { return this.DB.export(); },

    _runSchema() { this.DB.exec(SCHEMA); },

    _migrate() {
        this.DB.run('PRAGMA foreign_keys = ON;');
        // ensure app_config exists (older DBs predate it)
        const has = qAllRaw(this.DB, "SELECT name FROM sqlite_master WHERE type='table' AND name='app_config'");
        if (!has.length) {
            this._runSchema();
        }
        this._ensureConfig();
        // one-time repair: split parts under an income parent must be 'allocation',
        // not 'income' (mirrors _init_db in app.py)
        this.DB.run(
            "UPDATE transactions SET type='allocation' " +
            "WHERE parent_id IS NOT NULL AND type='income' " +
            "AND (SELECT type FROM transactions p WHERE p.id=transactions.parent_id)='income'");
    },

    _ensureConfig() {
        const rows = qAllRaw(this.DB, 'SELECT id FROM app_config');
        if (!rows.length) {
            this.DB.run('INSERT INTO app_config (id, data, updated_at) VALUES (1, ?, ?)',
                [JSON.stringify(defaultConfig()), nowISO()]);
        }
    },

    _dirty() { if (this.onChange) this.onChange(); },

    // ---- query helpers (SQLite rows -> plain objects) ----
    qAll(sql, params = []) { return qAllRaw(this.DB, sql, params).map(objOf); },
    q1(sql, params = []) { const r = qAllRaw(this.DB, sql, params); return r.length ? objOf(r[0]) : null; },
    run(sql, params = []) { this.DB.run(sql, params); },
    lastInsertId() { return this.q1('SELECT last_insert_rowid() AS id').id; },

    // ---- config (envelopes, review category, keywords) ----
    cfg() {
        const row = this.q1('SELECT data FROM app_config WHERE id=1');
        let c;
        try { c = row ? JSON.parse(row.data) : {}; } catch (e) { c = {}; }
        return {
            envelopes: Array.isArray(c.envelopes) ? c.envelopes : [],
            review_category: c.review_category || DEFAULT_REVIEW,
            keywords: c.keywords && typeof c.keywords === 'object' ? c.keywords : {},
        };
    },
    saveCfg(c) {
        const data = {
            envelopes: c.envelopes || [],
            review_category: c.review_category || DEFAULT_REVIEW,
            keywords: c.keywords || {},
        };
        this.run('INSERT OR REPLACE INTO app_config (id, data, updated_at) VALUES (1, ?, ?)',
            [JSON.stringify(data), nowISO()]);
    },

    // ---- active categories (envelopes + anything ever used) ----
    activeCategories() {
        const c = this.cfg();
        const extras = this.qAll('SELECT DISTINCT category FROM transactions WHERE category != ? AND category != ?',
            [c.review_category, PARENT_MARKER]).map(r => r.category);
        return c.envelopes.concat(extras.filter(x => !c.envelopes.includes(x)));
    },

    categories() {
        const c = this.cfg();
        const inDb = this.qAll('SELECT DISTINCT category FROM transactions WHERE category != ? AND category != ?',
            [c.review_category, PARENT_MARKER]).map(r => r.category).sort();
        const out = c.envelopes.slice();
        if (!out.includes(c.review_category)) out.push(c.review_category);
        inDb.forEach(x => { if (!out.includes(x)) out.push(x); });
        return out;
    },

    // ---- money logic (ports of the reference functions) ----
    summary() {
        const spent = {};
        this.qAll("SELECT category, SUM(-amount) AS t FROM transactions WHERE type='expense' " +
            "AND id NOT IN (SELECT DISTINCT parent_id FROM transactions WHERE parent_id IS NOT NULL) " +
            "GROUP BY category").forEach(r => spent[r.category] = r.t);
        const allocated = {};
        this.qAll("SELECT category, SUM(amount) AS t FROM transactions WHERE type='allocation' GROUP BY category")
            .forEach(r => allocated[r.category] = r.t);
        const rows = [];
        let balance = 0.0;
        for (const name of this.activeCategories()) {
            const available = round2((allocated[name] || 0) - (spent[name] || 0));
            balance += available;
            rows.push({ name, available });
        }
        const rev = this.cfg().review_category;
        rows.push({ name: rev, available: null });
        const reviewRows = this.qAll(
            "SELECT description, SUM(-amount) AS t FROM transactions WHERE type='expense' AND category=? GROUP BY description",
            [rev]).map(r => ({ description: r.description, amount: round2(r.t) }));
        return { balance: round2(balance), envelopes: rows, needs_review: reviewRows };
    },

    listTransactions(p) {
        const clauses = ['1=1'];
        const args = [];
        const txType = p.type || 'expense';
        if (txType && txType !== 'all') {
            if (txType === 'income') { clauses.push('type IN (?, ?)'); args.push('income', 'allocation'); }
            else { clauses.push('type = ?'); args.push(txType); }
        }
        if (p.category) { clauses.push('category = ?'); args.push(p.category); }
        if (p.q) { clauses.push('description LIKE ?'); args.push('%' + p.q + '%'); }
        if (p.date_from) { clauses.push('date >= ?'); args.push(p.date_from); }
        if (p.date_to) { clauses.push('date <= ?'); args.push(p.date_to); }
        const limit = Math.min(parseInt(p.limit || '200', 10) || 200, 1000);
        const offset = parseInt(p.offset || '0', 10) || 0;
        args.push(limit, offset);
        return this.qAll('SELECT * FROM transactions WHERE ' + clauses.join(' AND ') +
            ' ORDER BY date DESC, id ASC LIMIT ? OFFSET ?', args);
    },

    transactionParts(id) {
        const p = this.q1('SELECT id, type, category FROM transactions WHERE id=?', [id]);
        if (!p) return [];
        if (p.type === 'income' && p.category === PARENT_MARKER) {
            return this.qAll('SELECT category, SUM(amount) AS amount FROM transactions WHERE parent_id=? AND type=\'allocation\' GROUP BY category ORDER BY amount DESC', [id]);
        }
        if (p.type === 'expense') {
            return this.qAll('SELECT description, category, amount FROM transactions WHERE parent_id=? AND type=\'expense\' ORDER BY id', [id]);
        }
        return [];
    },

    hints() {
        const rev = this.cfg().review_category;
        const counts = {};
        const rows = this.qAll(
            "SELECT description, category FROM transactions " +
            "WHERE type='expense' AND category != ? AND category != ? AND LENGTH(description) > 0 " +
            "GROUP BY lower(description), category ORDER BY COUNT(*) DESC, MAX(id) DESC",
            [rev, PARENT_MARKER]);
        for (const r of rows) {
            const key = r.description;
            if (key && !(key in counts)) counts[key] = r.category;
        }
        return counts;
    },

    report(month) {
        if (!month || month.length !== 7 || month.charAt(4) !== '-') throw new Error('month must be YYYY-MM');
        const prefix = month + '%';
        const plannedRow = this.q1(
            'SELECT COALESCE(SUM(pa.amount),0) AS t FROM paycheck_allocations pa JOIN paychecks p ON p.id=pa.paycheck_id WHERE p.is_budget=0');
        const planned = plannedRow ? plannedRow.t : 0;

        const incomeDetail = {};
        const setIn = (key, amt, defaultName) => {
            const k = key || defaultName;
            if (!incomeDetail[k]) incomeDetail[k] = { name: k, amount: 0.0, count: 0 };
            incomeDetail[k].amount += amt;
            incomeDetail[k].count += 1;
        };
        this.qAll("SELECT description, amount FROM transactions WHERE type='income' AND date LIKE ?", [prefix])
            .forEach(r => setIn(r.description, r.amount, 'Income'));
        this.qAll("SELECT description, SUM(amount) AS t FROM transactions WHERE type='allocation' AND parent_id IS NULL " +
            "AND source != 'carryover' AND date LIKE ? GROUP BY lower(description), description", [prefix])
            .forEach(r => setIn(r.description, r.t, 'Allocation'));

        const expenseRows = this.qAll(
            "SELECT category, SUM(-amount) AS t FROM transactions WHERE type='expense' AND date LIKE ? " +
            "AND id NOT IN (SELECT DISTINCT parent_id FROM transactions WHERE parent_id IS NOT NULL) " +
            "GROUP BY category ORDER BY t DESC", [prefix])
            .map(r => ({ category: r.category, amount: round2(r.t) }));

        let received = 0, spent = 0;
        Object.values(incomeDetail).forEach(v => received += v.amount);
        expenseRows.forEach(r => spent += r.amount);
        received = round2(received); spent = round2(spent);
        return {
            month,
            planned: round2(planned),
            received,
            income_detail: Object.values(incomeDetail).sort((a, b) => b.amount - a.amount),
            spent,
            expenses: expenseRows,
            net: round2(received - spent),
        };
    },

    paychecks() {
        const rows = this.qAll('SELECT * FROM paychecks ORDER BY id');
        return rows.map(pk => {
            const allocations = this.qAll('SELECT category, amount FROM paycheck_allocations WHERE paycheck_id=? ORDER BY id', [pk.id]);
            return Object.assign({}, pk, { allocations });
        });
    },

    // ---- allocation helpers (ports of _clean_allocations / _scale_*) ----
    cleanAllocations(entries, amount) {
        const agg = {};
        for (const a of (entries || [])) {
            const cat = (a.category || '').trim();
            let amt = round2(parseFloat(a.amount) || 0);
            if (cat && amt > 0) agg[cat] = (agg[cat] || 0) + Math.round(amt * 100);
        }
        const cleaned = Object.entries(agg).filter(([, c]) => c > 0).map(([cat, c]) => [cat, c / 100]);
        if (Object.values(agg).reduce((s, c) => s + c, 0) !== Math.round(amount * 100)) return null;
        return cleaned;
    },

    scaleCents(cents, newTotalCents) {
        if (!cents.length || newTotalCents <= 0 || cents.reduce((s, c) => s + c, 0) <= 0) return new Array(cents.length).fill(0);
        const total = cents.reduce((s, c) => s + c, 0);
        const scaled = cents.map(c => Math.floor(c * newTotalCents / total));
        let rem = newTotalCents - scaled.reduce((s, c) => s + c, 0);
        const order = cents.map((_, i) => i).sort((a, b) => cents[b] - cents[a]);
        let k = 0;
        while (rem > 0) { scaled[order[k % order.length]] += 1; rem -= 1; k += 1; }
        return scaled;
    },

    scaleAllocations(allocations, oldTotalCents, newTotalCents) {
        const cats = allocations.map(a => a[0]);
        const cents = allocations.map(a => Math.round(a[1] * 100));
        const scaled = this.scaleCents(cents, newTotalCents);
        return cats.map((c, i) => [c, scaled[i] / 100]);
    },

    // ---- the API router (mirrors the Flask routes) ----
    async api(path, opts = {}) {
        if (!this.loaded) throw new Error('No budget loaded. Open or create a budget first.');
        const method = (opts.method || 'GET').toUpperCase();
        const body = opts.body ? JSON.parse(opts.body) : {};
        const m = path.match(/^\/api\/(.*)$/);
        if (!m) throw new Error('bad path: ' + path);
        let route = m[1];
        let query = {};
        const qi = route.indexOf('?');
        if (qi >= 0) {
            const sp = new URLSearchParams(route.slice(qi + 1));
            for (const k of ['type', 'category', 'q', 'date_from', 'date_to', 'limit', 'offset', 'month']) {
                if (sp.has(k)) query[k] = sp.get(k);
            }
            route = route.slice(0, qi);
        }
        const seg = route.split('/').filter(Boolean);

        let result;
        if (method === 'GET') {
            if (route === 'summary') result = this.summary();
            else if (route === 'transactions') result = this.listTransactions(query);
            else if (route === 'categories') result = this.categories();
            else if (route === 'hints') result = this.hints();
            else if (route === 'report') result = this.report(query.month || '');
            else if (route === 'paychecks') result = this.paychecks();
            else if (route === 'config') result = this.cfg();
            else if (seg[0] === 'transactions' && seg[2] === 'parts') result = this.transactionParts(parseInt(seg[1], 10));
            else throw new Error('unknown route: ' + route);
        } else if (method === 'POST') {
            if (route === 'transactions') result = this._addTransaction(body);
            else if (route === 'income') result = this._addIncome(body);
            else if (route === 'period/close') result = this._closePeriod(body);
            else if (route === 'paychecks') result = this._createPaycheck(body);
            else if (seg[0] === 'transactions' && seg[2] === 'split') result = this._splitTransaction(parseInt(seg[1], 10), body);
            else if (route === 'config') result = this._saveConfig(body);
            else throw new Error('unknown route: ' + route);
            this._dirty();
        } else if (method === 'PATCH') {
            if (seg[0] === 'transactions') result = this._updateTransaction(parseInt(seg[1], 10), body);
            else if (seg[0] === 'paychecks') result = this._updatePaycheck(parseInt(seg[1], 10), body);
            else throw new Error('unknown route: ' + route);
            this._dirty();
        } else if (method === 'DELETE') {
            if (seg[0] === 'transactions') result = this._deleteTransaction(parseInt(seg[1], 10));
            else if (seg[0] === 'paychecks') result = this._deletePaycheck(parseInt(seg[1], 10));
            else throw new Error('unknown route: ' + route);
            this._dirty();
        } else throw new Error('unsupported method: ' + method);

        return JSON.parse(JSON.stringify(result)); // deep clone, like a network round-trip
    },

    // ---- mutations (exact ports of the Flask handlers) ----
    _addTransaction(d) {
        const date = d.date, description = d.description, amount = d.amount,
            category = d.category, txType = d.type || 'expense';
        if (!(date && description !== undefined && description !== null &&
            amount !== undefined && amount !== null && category && txType)) {
            throw new Error('date, description, amount, category, type are required');
        }
        if (!['expense', 'income', 'allocation'].includes(txType)) throw new Error('type must be expense, income or allocation');
        let amt = round2(parseFloat(amount));
        if (!Number.isFinite(amt)) throw new Error('amount must be a number');
        if (amt === 0) throw new Error('amount must be non-zero');
        if (txType === 'expense' && amt > 0) amt = -amt;
        if ((txType === 'income' || txType === 'allocation') && amt < 0) amt = -amt;
        this.run('INSERT INTO transactions (date, description, amount, category, type, source) VALUES (?,?,?,?,?,?)',
            [date, description, amt, category, txType, 'manual']);
        return { id: this.lastInsertId() };
    },

    _addIncome(d) {
        const name = (d.name || '').trim();
        const date = (d.date || '').trim();
        let amount = round2(parseFloat(d.amount) || 0);
        if (!name) throw new Error('description is required');
        if (!date) throw new Error('date is required');
        if (amount <= 0) throw new Error('amount must be positive');
        const cleaned = this.cleanAllocations(d.allocations, amount);
        if (!cleaned) throw new Error('the split must equal the amount ($' + amount.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ')');
        this.run('INSERT INTO transactions (date, description, amount, category, type, source) VALUES (?,?,?,?,?,?)',
            [date, name, amount, PARENT_MARKER, 'income', 'manual']);
        const parentId = this.lastInsertId();
        for (const [cat, amt] of cleaned) {
            this.run('INSERT INTO transactions (date, description, amount, category, type, source, parent_id) VALUES (?,?,?,?,?,?,?)',
                [date, name, amt, cat, 'allocation', 'manual', parentId]);
        }
        return { id: parentId };
    },

    _splitTransaction(id, d) {
        const parts = d.parts || [];
        if (!parts.length) throw new Error('parts is required');
        const row = this.q1('SELECT * FROM transactions WHERE id=?', [id]);
        if (!row) throw new Error('not found');
        if (row.type === 'allocation') throw new Error('allocations cannot be split');
        const original = Math.abs(row.amount);
        const cleaned = [];
        for (const p of parts) {
            const amt = round2(parseFloat(p.amount));
            if (!Number.isFinite(amt)) throw new Error('invalid part amount');
            const cat = p.category;
            if (amt <= 0 || !cat) throw new Error('each part needs a positive amount and category');
            cleaned.push([amt, cat]);
        }
        if (Math.abs(cleaned.reduce((s, a) => s + a[0], 0) - original) > 0.01) {
            throw new Error('parts must sum to ' + original.toFixed(2));
        }
        this.run('DELETE FROM transactions WHERE parent_id=?', [id]);
        this.run('UPDATE transactions SET category=? WHERE id=?', [PARENT_MARKER, id]);
        const sign = row.type === 'expense' ? -1 : 1;
        const childType = row.type === 'expense' ? 'expense' : 'allocation';
        for (const [amt, cat] of cleaned) {
            this.run('INSERT INTO transactions (date, description, amount, category, type, source, parent_id) VALUES (?,?,?,?,?,?,?)',
                [row.date, row.description, sign * amt, cat, childType, 'manual', id]);
        }
        return { status: 'ok', parts: cleaned.length };
    },

    _deleteTransaction(id) {
        const row = this.q1('SELECT parent_id FROM transactions WHERE id=?', [id]);
        this.run('DELETE FROM transactions WHERE parent_id=?', [id]);
        this.run('DELETE FROM transactions WHERE id=?', [id]);
        if (row && row.parent_id) {
            const parent = this.q1('SELECT * FROM transactions WHERE id=?', [row.parent_id]);
            if (parent) {
                const kidsAmt = this.qAll('SELECT amount FROM transactions WHERE parent_id=?', [parent.id]);
                const partsTotal = round2(kidsAmt.reduce((s, k) => s + Math.abs(k.amount), 0));
                const psign = parent.type === 'expense' ? -1 : 1;
                this.run('UPDATE transactions SET amount=? WHERE id=?', [round2(psign * partsTotal), parent.id]);
            }
        }
        return { status: 'ok' };
    },

    _updateTransaction(id, d) {
        const row = this.q1('SELECT * FROM transactions WHERE id=?', [id]);
        if (!row) throw new Error('not found');
        const updates = {};

        if (d.amount !== undefined && d.amount !== null) {
            const amt = round2(parseFloat(d.amount));
            if (!Number.isFinite(amt)) throw new Error('amount must be a number');
            if (amt === 0) throw new Error('amount must be non-zero');
            if (row.type === 'expense') updates.amount = -Math.abs(amt);
            else if (row.type === 'allocation') updates.amount = amt; // keep sign user sent (carryovers can be negative)
            else updates.amount = Math.abs(amt);
        }
        if (d.description !== undefined && d.description !== null) {
            const desc = (d.description || '').trim();
            if (!desc) throw new Error('description cannot be empty');
            updates.description = desc;
        }
        if (d.date !== undefined && d.date !== null) {
            const date = (d.date || '').trim();
            if (date.length !== 10 || date.charAt(4) !== '-' || date.charAt(7) !== '-') throw new Error('date must be YYYY-MM-DD');
            updates.date = date;
        }
        if (d.category !== undefined && d.category !== null) {
            const cat = (d.category || '').trim();
            if (!cat || cat === PARENT_MARKER) throw new Error('that is not a valid category');
            if (row.category === PARENT_MARKER) throw new Error('a split/income total keeps its parts; edit the parts below it instead');
            updates.category = cat;
        }

        let newParts = null;
        if (d.parts !== undefined && d.parts !== null) {
            if (row.type === 'allocation') throw new Error('allocations cannot be split');
            if (row.parent_id !== null && row.parent_id !== undefined) throw new Error('a part cannot have parts; edit the total instead');
            const cleaned = [];
            for (const p of (d.parts || [])) {
                const amt = round2(parseFloat(p.amount));
                if (!Number.isFinite(amt)) throw new Error('each part needs a positive amount and category');
                const cat = p.category;
                if (amt <= 0 || !cat) throw new Error('each part needs a positive amount and category');
                cleaned.push([amt, cat]);
            }
            if (!cleaned.length) throw new Error('parts cannot be empty');
            const sign = row.type === 'expense' ? -1 : 1;
            updates.amount = sign * round2(cleaned.reduce((s, a) => s + a[0], 0));
            newParts = cleaned;
        }

        if (!Object.keys(updates).length) throw new Error('no fields to update');

        if (newParts) {
            const sign = row.type === 'expense' ? -1 : 1;
            const childType = row.type === 'expense' ? 'expense' : 'allocation';
            this.run('DELETE FROM transactions WHERE parent_id=?', [id]);
            const dateF = updates.date !== undefined ? updates.date : row.date;
            const descF = updates.description !== undefined ? updates.description : row.description;
            for (const [amt, cat] of newParts) {
                this.run('INSERT INTO transactions (date, description, amount, category, type, source, parent_id) VALUES (?,?,?,?,?,?,?)',
                    [dateF, descF, sign * amt, cat, childType, 'manual', id]);
            }
            this.run('UPDATE transactions SET amount=?, category=?, date=?, description=? WHERE id=?',
                [updates.amount, PARENT_MARKER, dateF, descF, id]);
            return { status: 'ok', parts: newParts.length };
        }

        const kids = this.qAll('SELECT * FROM transactions WHERE parent_id=? ORDER BY id', [id]);
        if (kids.length) {
            if (updates.amount !== undefined) {
                const cents = this.scaleCents(kids.map(k => Math.round(Math.abs(k.amount) * 100)),
                    Math.round(Math.abs(updates.amount) * 100));
                kids.forEach((k, i) => {
                    const sign = k.type === 'expense' ? -1 : 1;
                    this.run('UPDATE transactions SET amount=? WHERE id=?', [round2(sign * cents[i] / 100), k.id]);
                });
            }
            for (const f of ['date', 'description']) {
                if (updates[f] !== undefined) this.run('UPDATE transactions SET ' + f + '=? WHERE parent_id=?', [updates[f], id]);
            }
        }

        const fields = Object.keys(updates);
        this.run('UPDATE transactions SET ' + fields.map(f => f + '=?').join(', ') + ' WHERE id=?',
            fields.map(f => updates[f]).concat([id]));

        // part row: keep the parent total = sum of its parts
        if (row.parent_id !== null && row.parent_id !== undefined && updates.amount !== undefined) {
            const parent = this.q1('SELECT * FROM transactions WHERE id=?', [row.parent_id]);
            if (parent) {
                const kidsAmt = this.qAll('SELECT amount FROM transactions WHERE parent_id=?', [parent.id]);
                const partsTotal = round2(kidsAmt.reduce((s, k) => s + Math.abs(k.amount), 0));
                const psign = parent.type === 'expense' ? -1 : 1;
                this.run('UPDATE transactions SET amount=? WHERE id=?', [round2(psign * partsTotal), parent.id]);
            }
        }
        return { status: 'ok' };
    },

    _closePeriod(d) {
        const date = (d.date || '').trim();
        const amounts = d.amounts || {};
        if (!date) throw new Error('date is required');
        const valid = new Set(this.activeCategories());
        const cleaned = {};
        for (const [cat, v] of Object.entries(amounts)) {
            if (!valid.has(cat)) continue;
            const val = round2(parseFloat(v));
            cleaned[cat] = Number.isFinite(val) ? val : 0;
        }
        if (!Object.keys(cleaned).length) throw new Error('no envelope amounts provided');
        this.run('DELETE FROM transactions');
        for (const [cat, val] of Object.entries(cleaned)) {
            this.run("INSERT INTO transactions (date, description, amount, category, type, source) VALUES (?,?,?,?,?,?)",
                [date, 'Carryover', val, cat, 'allocation', 'carryover']);
        }
        return { status: 'ok', backup: '(see Drive backup)' };
    },

    _createPaycheck(d) {
        const name = (d.name || '').trim();
        if (!name) throw new Error('name cannot be empty');
        let balance;
        if (d.balance === undefined || d.balance === null || d.balance === '') balance = 0;
        else { balance = round2(parseFloat(d.balance)); if (!Number.isFinite(balance)) throw new Error('amount must be a number'); }
        if (!(balance > 0)) throw new Error('amount must be positive');
        const allocations = this.cleanAllocations(d.allocations, balance);
        if (!allocations) throw new Error('the split must equal the amount ($' + balance.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ')');
        const date = (d.date || '').trim() || todayISO();
        const isBudget = d.is_budget ? 1 : 0;
        this.run('INSERT INTO paychecks (name, balance, is_budget, date) VALUES (?,?,?,?)', [name, balance, isBudget, date]);
        const pkId = this.lastInsertId();
        for (const [cat, amt] of allocations) this.run('INSERT INTO paycheck_allocations (paycheck_id, category, amount) VALUES (?,?,?)', [pkId, cat, amt]);
        const pk = this.q1('SELECT * FROM paychecks WHERE id=?', [pkId]);
        const a = this.qAll('SELECT category, amount FROM paycheck_allocations WHERE paycheck_id=? ORDER BY id', [pkId]);
        return Object.assign({}, pk, { allocations: a });
    },

    _updatePaycheck(pkId, d) {
        const old = this.q1('SELECT * FROM paychecks WHERE id=?', [pkId]);
        if (!old) throw new Error('not found');
        const name = d.name !== undefined ? (d.name || '').trim() : old.name;
        if (d.name !== undefined && !name) throw new Error('name cannot be empty');
        let balance = old.balance;
        if (d.balance !== undefined && d.balance !== null && d.balance !== '') {
            const b = round2(parseFloat(d.balance));
            if (Number.isFinite(b)) balance = b; // non-numeric falls back to the stored balance, like the reference
        }
        if (!(balance > 0)) throw new Error('amount must be positive');
        const date = d.date !== undefined ? ((d.date || '').trim() || old.date) : old.date;
        const isBudget = d.is_budget !== undefined ? (d.is_budget ? 1 : 0) : old.is_budget;

        let existing = this.qAll('SELECT category, amount FROM paycheck_allocations WHERE paycheck_id=? ORDER BY id', [pkId])
            .map(r => [r.category, r.amount]);
        let replace = false;
        if (d.allocations !== undefined) {
            const cleaned = this.cleanAllocations(d.allocations, balance);
            if (!cleaned) throw new Error('the split must equal the amount ($' + balance.toLocaleString('en-US', { minimumFractionDigits: 2 }) + ')');
            existing = cleaned;
            replace = true;
        } else if (Math.abs(balance - old.balance) > 0.0001 && existing.length) {
            const oldTotal = existing.reduce((s, [, a]) => s + Math.round(a * 100), 0);
            if (oldTotal > 0) { existing = this.scaleAllocations(existing, oldTotal, Math.round(balance * 100)); replace = true; }
        }
        this.run('UPDATE paychecks SET name=?, balance=?, date=?, is_budget=? WHERE id=?', [name, balance, date, isBudget, pkId]);
        if (replace) {
            this.run('DELETE FROM paycheck_allocations WHERE paycheck_id=?', [pkId]);
            for (const [cat, amt] of existing) this.run('INSERT INTO paycheck_allocations (paycheck_id, category, amount) VALUES (?,?,?)', [pkId, cat, amt]);
        }
        const pk = this.q1('SELECT * FROM paychecks WHERE id=?', [pkId]);
        const a = this.qAll('SELECT category, amount FROM paycheck_allocations WHERE paycheck_id=? ORDER BY id', [pkId]);
        return Object.assign({}, pk, { allocations: a });
    },

    _deletePaycheck(pkId) {
        this.run('DELETE FROM paychecks WHERE id=?', [pkId]);
        return { status: 'ok' };
    },

    _saveConfig(body) {
        const cur = this.cfg();
        const next = {
            envelopes: body.envelopes !== undefined ? body.envelopes : cur.envelopes,
            review_category: body.review_category !== undefined ? body.review_category : cur.review_category,
            keywords: body.keywords !== undefined ? body.keywords : cur.keywords,
        };
        if (body.envelopes !== undefined) {
            // keep names tidy: strip empties, drop dupes case-insensitively
            const seen = new Set();
            next.envelopes = next.envelopes
                .map(e => String(e).trim())
                .filter(e => { if (!e) return false; const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        }
        if (!next.review_category) next.review_category = DEFAULT_REVIEW;
        this.saveCfg(next);
        this._dirty();
        return next;
    },
};

// ---- tiny row helpers (kept out of Backend for clarity) ----
function qAllRaw(db, sql, params) {
    const stmt = db.prepare(sql);
    if (params && params.length) stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
}
function objOf(o) { return Object.assign({}, o); }
function defaultConfig() {
    return { envelopes: [], review_category: DEFAULT_REVIEW, keywords: {} };
}
