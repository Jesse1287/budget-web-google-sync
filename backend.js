// backend.js — in-browser data layer (a port of reference/app.py onto SQL.js).
// No server: the whole database lives in memory; app.js calls Backend.api(path, opts)
// exactly like it called fetch(). Every mutation is auto-saved by app.js after each
// call, so a typo fix recalculates balances/reports immediately and persists.
'use strict';

const PARENT_MARKER = '__split__';
const DEFAULT_REVIEW = 'Needs Review';
// Card charges that were never tagged with a real category all land here when
// the card is paid, so an untagged statement still shows up as one honest
// expense instead of vanishing.
const CC_CATEGORY = 'Credit Card';
// Rows the app writes itself to keep a pair or a ledger balanced. The generic
// editor and the split dialog must leave them alone: editing one leg would
// split the pair, and editing a savings/card row would leave its ledger row
// disagreeing with the budget. Deleting the head is the way to undo one.
const SYS_ROW_LABEL = {
    transfer: 'transfer',
    cc_payment: 'card payment',
    savings: 'savings move',
    savings_withdrawal: 'savings move',
};

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
CREATE TABLE IF NOT EXISTS savings_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'adjust')),
    amount REAL NOT NULL,
    note TEXT,
    tx_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS credit_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS credit_card_charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    category TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- A charge can be split across categories (one store run: Food + Household).
-- Parts must add up to the charge; a charge without parts uses its category.
CREATE TABLE IF NOT EXISTS credit_card_charge_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    charge_id INTEGER NOT NULL REFERENCES credit_card_charges(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0)
);
-- The payment log records money that was applied to a card. tx_id is
-- deliberately not a foreign key: period close wipes transaction detail, and
-- the card must not suddenly look unpaid again after a close.
CREATE TABLE IF NOT EXISTS cc_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
    tx_id INTEGER,
    date TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0)
);
-- One point per month so the Overview can show a trend. Captured when the
-- month is first opened and again when the period is closed.
CREATE TABLE IF NOT EXISTS net_worth_history (
    month TEXT PRIMARY KEY,
    checking REAL NOT NULL,
    savings REAL NOT NULL,
    debt REAL NOT NULL,
    captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_cc_charge ON credit_card_charges(card_id, date, id);
CREATE INDEX IF NOT EXISTS idx_cc_payment ON cc_payments(card_id, date, id);
CREATE INDEX IF NOT EXISTS idx_cc_part ON credit_card_charge_parts(charge_id, id);
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

    // Read-only look at a .db file the user picked (Settings → Data → Import),
    // done on a throwaway connection so a wrong pick is rejected before the
    // budget that is open right now is touched at all.
    inspectBinary(bytes) {
        const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        if (!u8.length) return { ok: false, reason: 'That file is empty.' };
        const head = String.fromCharCode.apply(null, Array.prototype.slice.call(u8.subarray(0, 15)));
        if (head !== 'SQLite format 3') {
            return { ok: false, reason: 'That file is not a database file. The one to pick is named budget.db.' };
        }
        let db = null;
        try {
            db = new this.SQL.Database(u8);
            const tables = qAllRaw(db, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
            const has = (t) => tables.indexOf(t) >= 0;
            if (!has('transactions') && !has('app_config')) {
                return { ok: false, reason: 'That database has no budget data in it (no transactions and no settings).' };
            }
            const count = (t) => has(t) ? qAllRaw(db, 'SELECT COUNT(*) AS n FROM ' + t)[0].n : 0;
            let categories = 0;
            if (has('app_config')) {
                const row = qAllRaw(db, 'SELECT data FROM app_config WHERE id=1')[0];
                try {
                    const c = row ? JSON.parse(row.data) : {};
                    if (Array.isArray(c.envelopes)) categories = c.envelopes.length;
                } catch (e) { /* unreadable settings count as no categories */ }
            }
            return {
                ok: true,
                size: u8.length,
                transactions: count('transactions'),
                paychecks: count('paychecks'),
                categories: categories
            };
        } catch (e) {
            return { ok: false, reason: 'That file could not be opened as a database (' + ((e && e.message) || 'unknown error') + ').' };
        } finally {
            if (db) { try { db.close(); } catch (e) {} }
        }
    },

    _runSchema() { this.DB.exec(SCHEMA); },

    _migrate() {
        this.DB.run('PRAGMA foreign_keys = ON;');
        // Every statement is CREATE ... IF NOT EXISTS, so running the whole
        // schema is a no-op on a current file and the only way an older Drive
        // copy ever gains a table added by a newer version (savings_events,
        // credit cards). Never drop or rename anything here: old and new
        // devices must be able to share one budget.db during a release.
        this._runSchema();
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
            savings_category: typeof c.savings_category === 'string' ? c.savings_category : '',
            savings_account_name: c.savings_account_name || 'Savings account',
        };
    },
    saveCfg(c) {
        // Callers pass only the parts they are changing; the rest come from the
        // stored config so a category rename cannot silently forget the savings
        // pointer or the account name.
        const cur = this.cfg();
        const data = {
            envelopes: c.envelopes !== undefined ? c.envelopes : cur.envelopes,
            review_category: c.review_category || cur.review_category || DEFAULT_REVIEW,
            keywords: c.keywords !== undefined ? c.keywords : cur.keywords,
            savings_category: c.savings_category !== undefined ? c.savings_category : cur.savings_category,
            savings_account_name: c.savings_account_name !== undefined ? c.savings_account_name : cur.savings_account_name,
        };
        this.run('INSERT OR REPLACE INTO app_config (id, data, updated_at) VALUES (1, ?, ?)',
            [JSON.stringify(data), nowISO()]);
    },

    // ---- active categories (envelopes + anything ever used) ----
    activeCategories() {
        const c = this.cfg();
        const extras = this.qAll('SELECT DISTINCT category FROM transactions WHERE category != ? AND category != ?',
            [c.review_category, PARENT_MARKER]).map(r => r.category);
        this.qAll('SELECT DISTINCT category FROM paycheck_allocations WHERE category != ? AND category != ?',
            [c.review_category, PARENT_MARKER]).forEach(r => {
                if (!extras.includes(r.category)) extras.push(r.category);
            });
        return c.envelopes.concat(extras.filter(x => !c.envelopes.includes(x)));
    },

    categories() {
        const c = this.cfg();
        const inDb = this.qAll('SELECT DISTINCT category FROM transactions WHERE category != ? AND category != ?',
            [c.review_category, PARENT_MARKER]).map(r => r.category);
        this.qAll('SELECT DISTINCT category FROM paycheck_allocations WHERE category != ? AND category != ?',
            [c.review_category, PARENT_MARKER]).forEach(r => {
                if (!inDb.includes(r.category)) inDb.push(r.category);
            });
        inDb.sort();
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
            // A transfer is a split-shaped pair: the head and both legs carry
            // source='transfer', so asking for the source lists the whole
            // block and the Transactions tab can group it like any split.
            if (txType === 'transfer') { clauses.push('source = ?'); args.push('transfer'); }
            else if (txType === 'income') { clauses.push('type IN (?, ?)'); args.push('income', 'allocation'); }
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
            "AND source NOT IN ('transfer', 'cc_payment', 'savings', 'savings_withdrawal') " +
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
            "AND source != 'carryover' AND source != 'transfer' AND source != 'savings_withdrawal' AND date LIKE ? " +
            "GROUP BY lower(description), description", [prefix])
            .forEach(r => setIn(r.description, r.t, 'Allocation'));

        const expenseRows = this.qAll(
            "SELECT category, SUM(-amount) AS t FROM transactions WHERE type='expense' AND date LIKE ? " +
            "AND source != 'savings' " +
            "AND id NOT IN (SELECT DISTINCT parent_id FROM transactions WHERE parent_id IS NOT NULL) " +
            "GROUP BY category ORDER BY t DESC", [prefix])
            .map(r => ({ category: r.category, amount: round2(r.t) }));

        // Money moved to the bank savings account left checking, but it is not
        // "spending" and coming back is not "income" — show both as their own
        // line so the month still adds up without pretending to have spent it.
        const savingsTo = this.q1("SELECT COALESCE(SUM(-amount),0) AS t FROM transactions " +
            "WHERE type='expense' AND source='savings' AND date LIKE ?", [prefix]).t;
        const savingsFrom = this.q1("SELECT COALESCE(SUM(amount),0) AS t FROM transactions " +
            "WHERE type='allocation' AND source='savings_withdrawal' AND date LIKE ?", [prefix]).t;

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
            savings: { to: round2(savingsTo), from: round2(savingsFrom) },
            net: round2(received - spent),
        };
    },

    // ---- savings account (outside the checking budget) ----
    // The page's balance is the money at the bank, derived from its own event
    // log. The Savings *category* is the staging envelope in checking: it holds
    // money until it is actually moved, at which point the category is debited.
    savings() {
        const c = this.cfg();
        const category = c.savings_category || '';
        const known = Boolean(category) && this.categories().includes(category);
        const balance = this.q1('SELECT COALESCE(SUM(amount),0) AS t FROM savings_events').t;
        let available = null;
        if (known) {
            const allocated = this.q1("SELECT COALESCE(SUM(amount),0) AS t FROM transactions " +
                "WHERE type='allocation' AND category=?", [category]).t;
            const spent = this.q1("SELECT COALESCE(SUM(-amount),0) AS t FROM transactions WHERE type='expense' AND category=? " +
                "AND id NOT IN (SELECT DISTINCT parent_id FROM transactions WHERE parent_id IS NOT NULL)", [category]).t;
            available = round2(allocated - spent);
        }
        const events = this.qAll('SELECT * FROM savings_events ORDER BY date DESC, id DESC LIMIT 200')
            .map(e => ({ id: e.id, date: e.date, kind: e.kind, amount: round2(e.amount), note: e.note || '', tx_id: e.tx_id }));
        let setAsides = [];
        if (category) {
            setAsides = this.qAll(
                "SELECT p.date AS date, mine.amount AS amount, " +
                "  (SELECT other.category FROM transactions other WHERE other.parent_id=p.id AND other.category != ?) AS other " +
                "FROM transactions p JOIN transactions mine ON mine.parent_id=p.id " +
                "WHERE p.source='transfer' AND p.parent_id IS NULL AND mine.category=? " +
                "ORDER BY p.date DESC, p.id DESC LIMIT 100", [category, category])
                .map(r => ({ date: r.date, amount: round2(r.amount), other: r.other || '—' }));
        }
        return {
            name: c.savings_account_name || 'Savings account',
            category: category,
            category_known: known,
            balance: round2(balance),
            available: available,
            events: events,
            set_asides: setAsides,
            months: this._savingsMonths(category),
        };
    },

    _savingsMonths(category) {
        const map = {};
        const row = month => {
            if (!map[month]) map[month] = { month: month, set_aside: 0, to_account: 0, from_account: 0, change: 0 };
            return map[month];
        };
        this.qAll("SELECT substr(date,1,7) AS month, kind, SUM(amount) AS t FROM savings_events " +
            "GROUP BY substr(date,1,7), kind").forEach(r => {
            const m = row(r.month);
            if (r.kind === 'deposit') m.to_account = round2(r.t);
            else if (r.kind === 'withdrawal') m.from_account = round2(-r.t);
            m.change = round2(m.change + r.t);
        });
        if (category) {
            this.qAll("SELECT substr(t.date,1,7) AS month, SUM(t.amount) AS t FROM transactions t " +
                "JOIN transactions p ON p.id=t.parent_id " +
                "WHERE p.source='transfer' AND t.category=? GROUP BY substr(t.date,1,7)", [category])
                .forEach(r => { row(r.month).set_aside = round2(r.t); });
        }
        return Object.values(map).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6);
    },

    _savingsPatch(d) {
        const c = this.cfg();
        let category = c.savings_category;
        if (d.category !== undefined) {
            category = String(d.category || '').trim();
            if (category && !this.categories().includes(category)) throw new Error('"' + category + '" is not a category any more');
            if (category.toLowerCase() === c.review_category.toLowerCase()) throw new Error('the review category cannot hold savings');
        }
        let name = c.savings_account_name;
        if (d.name !== undefined) {
            name = String(d.name || '').trim() || 'Savings account';
        }
        this.saveCfg({ savings_category: category, savings_account_name: name });
        return { name: name, category: category };
    },

    _savingsDeposit(d) {
        const c = this.cfg();
        const category = c.savings_category;
        if (!category) throw new Error('pick which category holds your savings first');
        const amount = round2(parseFloat(d.amount));
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be greater than zero');
        const date = this._dateField(d.date);
        const note = String(d.note || '').trim();
        this.run('INSERT INTO transactions (date, description, amount, category, type, source) VALUES (?,?,?,?,?,?)',
            [date, 'Move to savings account' + (note ? ' — ' + note : ''), -amount, category, 'expense', 'savings']);
        const txId = this.lastInsertId();
        this.run('INSERT INTO savings_events (date, kind, amount, note, tx_id) VALUES (?,?,?,?,?)',
            [date, 'deposit', amount, note || null, txId]);
        return { txId: txId, accounts: this.savings() };
    },

    _savingsWithdraw(d) {
        const c = this.cfg();
        const amount = round2(parseFloat(d.amount));
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be greater than zero');
        const date = this._dateField(d.date);
        const note = String(d.note || '').trim();
        const balance = round2(this.q1('SELECT COALESCE(SUM(amount),0) AS t FROM savings_events').t);
        if (amount > balance + 0.005) {
            throw new Error('the savings account only has $' + balance.toFixed(2) + ' in it');
        }
        const category = String(d.category || c.savings_category || '').trim();
        if (!category) throw new Error('pick the category the money goes back into');
        if (!this.categories().includes(category)) throw new Error('"' + category + '" is not a category any more');
        if (category.toLowerCase() === c.review_category.toLowerCase()) throw new Error('the review category cannot receive savings');
        this.run('INSERT INTO transactions (date, description, amount, category, type, source) VALUES (?,?,?,?,?,?)',
            [date, 'From savings account' + (note ? ' — ' + note : ''), amount, category, 'allocation', 'savings_withdrawal']);
        const txId = this.lastInsertId();
        this.run('INSERT INTO savings_events (date, kind, amount, note, tx_id) VALUES (?,?,?,?,?)',
            [date, 'withdrawal', -amount, note || null, txId]);
        return { txId: txId, accounts: this.savings() };
    },

    // Reconciling with the bank: the account is outside the budget, so the
    // difference is recorded on the account only. No transaction is created.
    _savingsAdjust(d) {
        const target = round2(parseFloat(d.balance));
        if (!Number.isFinite(target)) throw new Error('balance must be a number');
        if (target < 0) throw new Error('a savings account balance cannot be negative');
        const date = this._dateField(d.date);
        const note = String(d.note || '').trim();
        const current = round2(this.q1('SELECT COALESCE(SUM(amount),0) AS t FROM savings_events').t);
        const diff = round2(target - current);
        if (Math.abs(diff) < 0.005) return { changed: false, balance: current, accounts: this.savings() };
        this.run('INSERT INTO savings_events (date, kind, amount, note, tx_id) VALUES (?,?,?,?,?)',
            [date, 'adjust', diff, note || null, null]);
        return { changed: true, diff: diff, accounts: this.savings() };
    },

    _dateField(v) {
        const date = String(v || '').trim();
        if (date.length !== 10 || date.charAt(4) !== '-' || date.charAt(7) !== '-') throw new Error('date must be YYYY-MM-DD');
        return date;
    },

    // ---- credit cards (charges live here until the card is paid) ----
    // Nothing on this page touches the budget: a charge is a note that money
    // was put on a card. Only "Pay card" turns charges into a real expense,
    // because that is the moment money actually leaves checking.
    //
    // What is paid is derived, never stored: payments are replayed in
    // (date, id) order against charges in (date, id) order, so deleting a
    // payment transaction (which deletes its log row) makes the charges show
    // as unpaid again without any bookkeeping to repair.
    _ccCharges(cardId) {
        return this.qAll('SELECT * FROM credit_card_charges WHERE card_id=? ORDER BY date, id', [cardId])
            .map(c => ({
                id: c.id,
                date: c.date,
                description: c.description,
                amount: round2(c.amount),
                category: c.category || '',
                cents: Math.round(round2(c.amount) * 100),
                parts: this.qAll('SELECT * FROM credit_card_charge_parts WHERE charge_id=? ORDER BY id', [c.id])
                    .map(p => ({
                        id: p.id,
                        category: p.category || '',
                        amount: round2(p.amount),
                        cents: Math.round(round2(p.amount) * 100),
                    })),
                paidC: 0,
                paid_date: null,
            }));
    },

    // The (category, cents) pieces money is attributed to, in order. A split
    // charge uses its parts; anything else is one piece carrying the charge's
    // own tag. Stored order is the order money is consumed in, so a part payment
    // pays the first categories on that charge first.
    _chargeSlices(charge) {
        if (!charge.parts.length) return [[charge.category, charge.cents]];
        return charge.parts.map(p => [p.category, p.cents]);
    },

    _ccPayments(cardId) {
        return this.qAll('SELECT * FROM cc_payments WHERE card_id=? ORDER BY date, id', [cardId])
            .map(p => ({ date: p.date, cents: Math.round(round2(p.amount) * 100) }));
    },

    // Oldest charge first, oldest payment first. Returns how many cents each
    // payment consumed from which charge, so both the card list and the payment
    // preview run exactly the same walk.
    _ccConsume(charges, payments) {
        const used = [];
        let ci = 0;
        let leftC = charges.length ? charges[0].cents : 0;
        for (const p of payments) {
            let payC = p.cents;
            while (payC > 0 && ci < charges.length) {
                if (leftC <= 0) {
                    ci += 1;
                    leftC = ci < charges.length ? charges[ci].cents : 0;
                    continue;
                }
                const take = Math.min(payC, leftC);
                used.push({ idx: ci, cents: take, date: p.date });
                payC -= take;
                leftC -= take;
            }
        }
        return used;
    },

    _ccState(cardId) {
        const charges = this._ccCharges(cardId);
        const used = this._ccConsume(charges, this._ccPayments(cardId));
        used.forEach(u => {
            const c = charges[u.idx];
            c.paidC += u.cents;
            if (c.paidC >= c.cents) c.paid_date = u.date;
        });
        const totalC = charges.reduce((s, c) => s + c.cents, 0);
        const paidC = charges.reduce((s, c) => s + c.paidC, 0);
        return { charges: charges, totalC: totalC, paidC: paidC, owedC: Math.max(0, totalC - paidC) };
    },

    // Which categories a payment of `amountC` cents would debit, grouped the
    // way the payment transaction is split. A split charge contributes its parts
    // in order; a tag that no longer names a real category falls back to "Credit
    // Card" instead of resurrecting a retired name or draining the review
    // bucket (which has no balance to drain).
    _ccGroups(cardId, amountC) {
        const st = this._ccState(cardId);
        const appliedC = Math.min(amountC, st.owedC);
        if (appliedC <= 0) throw new Error('nothing is owed on this card');
        const full = new Set(this.activeCategories());
        const cents = {};
        let left = appliedC;
        for (const c of st.charges) {
            if (left <= 0) break;
            const free = c.cents - c.paidC;
            if (free <= 0) continue;
            const planned = Math.min(left, free);
            let remaining = planned;
            // Skip the cents of this charge that earlier payments already took.
            let skip = c.paidC;
            for (const [cat, pcents] of this._chargeSlices(c)) {
                if (remaining <= 0) break;
                if (skip >= pcents) { skip -= pcents; continue; }
                const take = Math.min(remaining, pcents - skip);
                const key = (cat && full.has(cat)) ? cat : CC_CATEGORY;
                cents[key] = (cents[key] || 0) + take;
                remaining -= take;
                skip = 0;
            }
            if (remaining > 0) {
                // Only reachable if stored parts do not add up to their charge.
                const key = (c.category && full.has(c.category)) ? c.category : CC_CATEGORY;
                cents[key] = (cents[key] || 0) + remaining;
            }
            left -= planned;
        }
        // Rounding safety net: cents are integers, so this only fires if the
        // records somehow disagree — put the leftover on the biggest group so
        // the split always sums to the payment to the cent.
        if (left > 0) {
            const keys = Object.keys(cents);
            const biggest = keys.sort((a, b) => cents[b] - cents[a])[0];
            if (biggest) cents[biggest] += left;
        }
        const groups = Object.keys(cents)
            .map(k => ({ category: k, amount: round2(cents[k] / 100) }))
            .sort((a, b) => b.amount - a.amount);
        return { appliedC: appliedC, groups: groups };
    },

    creditCards() {
        return this.qAll('SELECT * FROM credit_cards ORDER BY id').map(c => {
            const st = this._ccState(c.id);
            const last = this.q1('SELECT MAX(date) AS d FROM cc_payments WHERE card_id=?', [c.id]);
            return {
                id: c.id,
                name: c.name,
                owed: round2(st.owedC / 100),
                paid_total: round2(st.paidC / 100),
                last_payment_date: last && last.d ? last.d : null,
                charges: st.charges.map(ch => ({
                    id: ch.id,
                    date: ch.date,
                    description: ch.description,
                    amount: ch.amount,
                    category: ch.category,
                    parts: ch.parts.map(p => ({ category: p.category, amount: p.amount })),
                    paid: round2(ch.paidC / 100),
                    status: ch.paidC <= 0 ? 'unpaid' : (ch.paidC >= ch.cents ? 'paid' : 'partial'),
                    paid_date: ch.paid_date,
                })),
            };
        });
    },

    _ccCard(cardId) {
        const card = this.q1('SELECT * FROM credit_cards WHERE id=?', [cardId]);
        if (!card) throw new Error('that credit card is no longer here');
        return card;
    },

    _ccPreview(cardId, amount) {
        this._ccCard(cardId);
        const amtC = Math.round(round2(parseFloat(amount)) * 100);
        if (!Number.isFinite(amtC) || amtC <= 0) throw new Error('amount must be greater than zero');
        const st = this._ccState(cardId);
        if (amtC > st.owedC) throw new Error('only $' + (st.owedC / 100).toFixed(2) + ' is owed on this card');
        const g = this._ccGroups(cardId, amtC);
        return { amount: round2(g.appliedC / 100), owed: round2(st.owedC / 100), groups: g.groups, remaining: round2((st.owedC - g.appliedC) / 100) };
    },

    _ccCreateCard(d) {
        const name = String(d.name || '').trim() || 'Credit card';
        this.run('INSERT INTO credit_cards (name) VALUES (?)', [name]);
        return { id: this.lastInsertId(), name: name };
    },

    _ccRenameCard(cardId, d) {
        const card = this._ccCard(cardId);
        const name = String(d.name !== undefined ? d.name : card.name).trim();
        if (!name) throw new Error('the card needs a name');
        this.run('UPDATE credit_cards SET name=? WHERE id=?', [name, cardId]);
        return { id: cardId, name: name };
    },

    _ccDeleteCard(cardId) {
        this._ccCard(cardId);
        const st = this._ccState(cardId);
        if (st.owedC > 0) throw new Error('pay the card off before deleting it — $' + (st.owedC / 100).toFixed(2) + ' is still owed');
        this.run('DELETE FROM credit_cards WHERE id=?', [cardId]);
        return { status: 'ok' };
    },

    // Validate a charge's split: positive amounts, a category each, and parts
    // that add up to the charge to the cent.
    _cleanChargeParts(parts, amount) {
        const cleaned = [];
        for (const p of (parts || [])) {
            const cat = String((p && p.category) || '').trim();
            if (!cat) throw new Error('each part needs a category');
            const amt = round2(parseFloat(p && p.amount));
            if (!Number.isFinite(amt) || amt <= 0) throw new Error('each part needs a positive amount');
            cleaned.push([cat, amt]);
        }
        if (!cleaned.length) throw new Error('parts cannot be empty');
        const total = round2(cleaned.reduce((s, a) => s + a[1], 0));
        if (Math.abs(total - amount) > 0.005) {
            throw new Error('the parts must add up to $' + amount.toFixed(2) + ' (they add up to $' + total.toFixed(2) + ')');
        }
        return cleaned;
    },

    // Replace a charge's parts. A one-part split is just a tag, so it is stored
    // as `category` with no part rows; anything else is stored as parts.
    _storeChargeParts(chargeId, parts) {
        this.run('DELETE FROM credit_card_charge_parts WHERE charge_id=?', [chargeId]);
        if (parts.length === 1) {
            this.run('UPDATE credit_card_charges SET category=? WHERE id=?', [parts[0][0], chargeId]);
            return;
        }
        this.run('UPDATE credit_card_charges SET category=NULL WHERE id=?', [chargeId]);
        for (const [cat, amt] of parts) {
            this.run('INSERT INTO credit_card_charge_parts (charge_id, category, amount) VALUES (?,?,?)',
                [chargeId, cat, amt]);
        }
    },

    _ccAddCharge(cardId, d) {
        this._ccCard(cardId);
        const date = this._dateField(d.date);
        const description = String(d.description || '').trim();
        if (!description) throw new Error('what was bought? a short description is required');
        const amount = round2(parseFloat(d.amount));
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be greater than zero');
        const parts = (d.parts !== undefined && d.parts !== null) ? this._cleanChargeParts(d.parts, amount) : null;
        const category = String(d.category || '').trim();
        this.run('INSERT INTO credit_card_charges (card_id, date, description, amount, category) VALUES (?,?,?,?,?)',
            [cardId, date, description, amount, category || null]);
        const chargeId = this.lastInsertId();
        if (parts) this._storeChargeParts(chargeId, parts);
        return { id: chargeId };
    },

    _ccUpdateCharge(cardId, chargeId, d) {
        this._ccCard(cardId);
        const row = this.q1('SELECT * FROM credit_card_charges WHERE id=? AND card_id=?', [chargeId, cardId]);
        if (!row) throw new Error('that charge is no longer here');
        // Once a payment has consumed part of a charge, the charge is history:
        // editing it would silently change what the payment meant.
        const st = this._ccState(cardId);
        const mine = st.charges.find(c => c.id === chargeId);
        if (mine && mine.paidC > 0) throw new Error('this charge is already (partly) paid — it cannot be changed any more');
        const updates = {};
        if (d.date !== undefined) updates.date = this._dateField(d.date);
        if (d.description !== undefined) {
            const desc = String(d.description || '').trim();
            if (!desc) throw new Error('description cannot be empty');
            updates.description = desc;
        }
        if (d.amount !== undefined) {
            const amt = round2(parseFloat(d.amount));
            if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be greater than zero');
            updates.amount = amt;
        }
        if (d.category !== undefined) updates.category = String(d.category || '').trim() || null;

        let parts = null;
        if (d.parts !== undefined && d.parts !== null) {
            parts = this._cleanChargeParts(d.parts, updates.amount !== undefined ? updates.amount : round2(row.amount));
            delete updates.category; // the parts carry the categories
        } else if (d.amount !== undefined && mine && mine.parts.length) {
            throw new Error('this charge is split — use Split to change the parts and their total');
        }
        const fields = Object.keys(updates);
        if (!fields.length && !parts) throw new Error('no fields to update');
        if (fields.length) {
            this.run('UPDATE credit_card_charges SET ' + fields.map(f => f + '=?').join(', ') + ' WHERE id=?',
                fields.map(f => updates[f]).concat([chargeId]));
        }
        if (parts) this._storeChargeParts(chargeId, parts);
        return { id: chargeId };
    },

    _ccDeleteCharge(cardId, chargeId) {
        this._ccCard(cardId);
        const st = this._ccState(cardId);
        const mine = st.charges.find(c => c.id === chargeId);
        if (!mine) throw new Error('that charge is no longer here');
        if (mine.paidC > 0) throw new Error('this charge is already (partly) paid — delete the payment instead');
        this.run('DELETE FROM credit_card_charges WHERE id=? AND card_id=?', [chargeId, cardId]);
        return { status: 'ok' };
    },

    // Paying the card is the only moment money leaves checking: one expense
    // (split per tag when there is more than one group) for exactly the amount
    // applied, plus a log row that marks the charges paid.
    _ccPay(cardId, d) {
        const card = this._ccCard(cardId);
        const date = this._dateField(d.date);
        const amtC = Math.round(round2(parseFloat(d.amount)) * 100);
        if (!Number.isFinite(amtC) || amtC <= 0) throw new Error('amount must be greater than zero');
        const st = this._ccState(cardId);
        if (st.owedC <= 0) throw new Error('nothing is owed on this card');
        if (amtC > st.owedC) throw new Error('only $' + (st.owedC / 100).toFixed(2) + ' is owed on this card');
        const g = this._ccGroups(cardId, amtC);
        const amount = round2(g.appliedC / 100);
        const description = 'Credit card payment — ' + card.name;

        let txId;
        if (g.groups.length === 1) {
            this.run('INSERT INTO transactions (date, description, amount, category, type, source) VALUES (?,?,?,?,?,?)',
                [date, description, -amount, g.groups[0].category, 'expense', 'cc_payment']);
            txId = this.lastInsertId();
        } else {
            this.run('INSERT INTO transactions (date, description, amount, category, type, source) VALUES (?,?,?,?,?,?)',
                [date, description, -amount, PARENT_MARKER, 'expense', 'cc_payment']);
            txId = this.lastInsertId();
            this._applySplit(txId, g.groups.map(x => [x.amount, x.category]), 'cc_payment');
        }
        this.run('INSERT INTO cc_payments (card_id, tx_id, date, amount) VALUES (?,?,?,?)',
            [cardId, txId, date, amount]);
        return {
            txId: txId,
            amount: amount,
            groups: g.groups,
            remaining: round2((st.owedC - g.appliedC) / 100),
        };
    },

    // ---- net worth history (one point per month) ----
    _netWorthNow(month) {
        const checking = this.summary().balance;
        const savings = this.q1('SELECT COALESCE(SUM(amount),0) AS t FROM savings_events').t;
        let debt = 0;
        for (const c of this.qAll('SELECT id FROM credit_cards')) {
            debt += this._ccState(c.id).owedC / 100;
        }
        return {
            month: month || todayISO().slice(0, 7),
            checking: round2(checking),
            savings: round2(savings),
            debt: round2(debt),
            net: round2(checking + savings - debt),
        };
    },

    captureNetWorth() {
        const point = this._netWorthNow();
        this.run('INSERT OR REPLACE INTO net_worth_history (month, checking, savings, debt, captured_at) VALUES (?,?,?,?,?)',
            [point.month, point.checking, point.savings, point.debt, nowISO()]);
        return point;
    },

    netWorthHistory() {
        return this.qAll('SELECT month, checking, savings, debt, captured_at FROM net_worth_history ORDER BY month')
            .map(r => ({
                month: r.month,
                checking: round2(r.checking),
                savings: round2(r.savings),
                debt: round2(r.debt),
                net: round2(r.checking + r.savings - r.debt),
            }));
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
            for (const k of ['type', 'category', 'q', 'date_from', 'date_to', 'limit', 'offset', 'month', 'amount']) {
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
            else if (route === 'savings') result = this.savings();
            else if (route === 'credit-cards') result = this.creditCards();
            else if (route === 'net-worth') result = this.netWorthHistory();
            else if (route === 'config') result = this.cfg();
            else if (seg[0] === 'transactions' && seg[2] === 'parts') result = this.transactionParts(parseInt(seg[1], 10));
            else if (seg[0] === 'credit-cards' && seg[2] === 'preview') result = this._ccPreview(parseInt(seg[1], 10), query.amount);
            else throw new Error('unknown route: ' + route);
        } else if (method === 'POST') {
            if (route === 'transactions') result = this._addTransaction(body);
            else if (route === 'income') result = this._addIncome(body);
            else if (route === 'transfers') result = this._addTransfer(body);
            else if (route === 'period/close') result = this._closePeriod(body);
            else if (route === 'paychecks') result = this._createPaycheck(body);
            else if (route === 'savings/deposit') result = this._savingsDeposit(body);
            else if (route === 'savings/withdraw') result = this._savingsWithdraw(body);
            else if (route === 'savings/adjust') result = this._savingsAdjust(body);
            else if (route === 'credit-cards') result = this._ccCreateCard(body);
            else if (route === 'net-worth/capture') result = this.captureNetWorth();
            else if (seg[0] === 'transactions' && seg[2] === 'split') result = this._splitTransaction(parseInt(seg[1], 10), body);
            else if (seg[0] === 'credit-cards' && seg[2] === 'charges') result = this._ccAddCharge(parseInt(seg[1], 10), body);
            else if (seg[0] === 'credit-cards' && seg[2] === 'pay') result = this._ccPay(parseInt(seg[1], 10), body);
            else if (seg[0] === 'categories' && seg[1] === 'merge') result = this._mergeCategory(body.from, body.to);
            else if (seg[0] === 'categories' && seg[1] === 'from-data') result = this._seedCategoriesFromData();
            else if (route === 'config') result = this._saveConfig(body);
            else throw new Error('unknown route: ' + route);
            this._dirty();
        } else if (method === 'PATCH') {
            if (seg[0] === 'transactions') result = this._updateTransaction(parseInt(seg[1], 10), body);
            else if (seg[0] === 'paychecks') result = this._updatePaycheck(parseInt(seg[1], 10), body);
            else if (route === 'savings') result = this._savingsPatch(body);
            else if (seg[0] === 'credit-cards' && seg[2] === 'charges') result = this._ccUpdateCharge(parseInt(seg[1], 10), parseInt(seg[3], 10), body);
            else if (seg[0] === 'credit-cards') result = this._ccRenameCard(parseInt(seg[1], 10), body);
            else throw new Error('unknown route: ' + route);
            this._dirty();
        } else if (method === 'DELETE') {
            if (seg[0] === 'transactions') result = this._deleteTransaction(parseInt(seg[1], 10));
            else if (seg[0] === 'paychecks') result = this._deletePaycheck(parseInt(seg[1], 10));
            else if (seg[0] === 'credit-cards' && seg[2] === 'charges') result = this._ccDeleteCharge(parseInt(seg[1], 10), parseInt(seg[3], 10));
            else if (seg[0] === 'credit-cards') result = this._ccDeleteCard(parseInt(seg[1], 10));
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

    // A transfer is one split-shaped pair: a head under __split__ and two
    // allocation legs (+X destination, −X source). summary() then moves the
    // money between the two envelopes and leaves the total untouched, and the
    // existing split rendering groups the three rows into one block.
    _addTransfer(d) {
        const from = String(d.from || '').trim();
        const to = String(d.to || '').trim();
        const date = String(d.date || '').trim();
        const note = String(d.note || '').trim();
        const amount = round2(parseFloat(d.amount));
        const rev = this.cfg().review_category;
        if (!from || !to) throw new Error('pick the category to move from and the one to move to');
        if (from === to) throw new Error('pick two different categories');
        if (from === PARENT_MARKER || to === PARENT_MARKER) throw new Error('that is not a valid category');
        if (from.toLowerCase() === rev.toLowerCase() || to.toLowerCase() === rev.toLowerCase()) {
            throw new Error('"' + rev + '" is the review category — it has no balance to move');
        }
        if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be greater than zero');
        if (date.length !== 10 || date.charAt(4) !== '-' || date.charAt(7) !== '-') throw new Error('date must be YYYY-MM-DD');

        const description = 'Transfer: ' + from + ' → ' + to + (note ? ' — ' + note : '');
        this.run('INSERT INTO transactions (date, description, amount, category, type, source) VALUES (?,?,?,?,?,?)',
            [date, description, amount, PARENT_MARKER, 'allocation', 'transfer']);
        const id = this.lastInsertId();
        this.run('INSERT INTO transactions (date, description, amount, category, type, source, parent_id) VALUES (?,?,?,?,?,?,?)',
            [date, description, amount, to, 'allocation', 'transfer', id]);
        this.run('INSERT INTO transactions (date, description, amount, category, type, source, parent_id) VALUES (?,?,?,?,?,?,?)',
            [date, description, -amount, from, 'allocation', 'transfer', id]);
        return { id, from, to, amount };
    },

    // The shared core of "turn this transaction into a split": drop the old
    // parts, mark the head, insert one leg per part. Used by the manual split
    // route and by the card payment, which must produce identical rows.
    _applySplit(id, parts, source) {
        const row = this.q1('SELECT * FROM transactions WHERE id=?', [id]);
        if (!row) throw new Error('not found');
        const sign = row.type === 'expense' ? -1 : 1;
        const childType = row.type === 'expense' ? 'expense' : 'allocation';
        this.run('DELETE FROM transactions WHERE parent_id=?', [id]);
        this.run('UPDATE transactions SET category=? WHERE id=?', [PARENT_MARKER, id]);
        for (const [amt, cat] of parts) {
            this.run('INSERT INTO transactions (date, description, amount, category, type, source, parent_id) VALUES (?,?,?,?,?,?,?)',
                [row.date, row.description, sign * amt, cat, childType, source || row.source, id]);
        }
        return { status: 'ok', parts: parts.length };
    },

    _splitTransaction(id, d) {
        const parts = d.parts || [];
        if (!parts.length) throw new Error('parts is required');
        const row = this.q1('SELECT * FROM transactions WHERE id=?', [id]);
        if (!row) throw new Error('not found');
        if (row.type === 'allocation') throw new Error('allocations cannot be split');
        if (SYS_ROW_LABEL[row.source]) throw new Error('this row is part of a ' + SYS_ROW_LABEL[row.source] +
            ' — delete it and do it again instead of splitting it');
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
        return this._applySplit(id, cleaned, 'manual');
    },

    _deleteTransaction(id) {
        const row = this.q1('SELECT * FROM transactions WHERE id=?', [id]);
        // A savings deposit/withdrawal owns an account event. Delete the event
        // with the transaction, so the account moves back the same amount and
        // the two never disagree. (The ledger deliberately has no FK: period
        // close wipes transactions but the account history must survive.)
        if (row && !row.parent_id && (row.source === 'savings' || row.source === 'savings_withdrawal')) {
            this.run('DELETE FROM savings_events WHERE tx_id=?', [id]);
        }
        // A card payment owns a log row. Delete it too, so the charges it
        // consumed show as unpaid again — the card and the budget never drift.
        if (row && !row.parent_id && row.source === 'cc_payment') {
            this.run('DELETE FROM cc_payments WHERE tx_id=?', [id]);
        }
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
        // Rows the app writes to keep a pair or a ledger balanced (a transfer,
        // a card payment, a savings move) must not be reshaped by the generic
        // editor: editing one leg splits the pair, and editing a savings row
        // leaves its account event disagreeing. Delete it and redo it.
        if (SYS_ROW_LABEL[row.source]) {
            throw new Error('this row is part of a ' + SYS_ROW_LABEL[row.source] +
                ' — delete it and do it again instead of editing it');
        }
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
        // Remember where the month ended, for the overview trend.
        this.captureNetWorth();
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

    // A file from the server-era app keeps its category list in config.json, so
    // it arrives with an empty saved list while the transactions still carry the
    // names. Rebuild the list from those names instead of asking the user to
    // retype every category. Safe to run twice: it only adds names not already
    // in the list, and never invents one that no transaction uses.
    _categoriesFromData() {
        const cur = this.cfg();
        const have = cur.envelopes.map(e => e.toLowerCase());
        return this.categories()
            .filter(c => c !== cur.review_category)
            .filter(c => !have.includes(c.toLowerCase()));
    },

    _seedCategoriesFromData() {
        const added = this._categoriesFromData();
        const cur = this.cfg();
        if (added.length) {
            this.saveCfg({
                envelopes: cur.envelopes.concat(added),
                review_category: cur.review_category,
                keywords: cur.keywords
            });
            this._dirty();
        }
        return { added: added };
    },

    // Move everything filed under one category onto another, then drop the old
    // name from the saved list. Retiring a category by hand means touching
    // expenses, split parts, income splits, saved checks and the keyword rules
    // separately, and missing one leaves the name alive forever.
    _mergeCategory(from, to) {
        const src = String(from || '').trim();
        const dst = String(to || '').trim();
        if (!src || !dst) throw new Error('pick the category to remove and the one to keep');
        if (src === dst) throw new Error('pick two different categories');
        if (src === PARENT_MARKER || dst === PARENT_MARKER) throw new Error('that category cannot be merged');
        const cur = this.cfg();
        // The review bucket is not an envelope: its balance is deliberately
        // outside the total, so merging in or out of it would move money
        // nowhere. Renaming it is the supported way to change it.
        const rev = cur.review_category.toLowerCase();
        if (src.toLowerCase() === rev || dst.toLowerCase() === rev) {
            throw new Error('"' + cur.review_category + '" is the review category — rename it in Settings instead of merging it');
        }
        // The name has to exist somewhere, or the button would silently do nothing.
        const known = this.categories().map(c => c.toLowerCase());
        if (!known.includes(src.toLowerCase())) throw new Error('"' + src + '" is not a category any more');

        let transactions = 0;
        for (const r of this.qAll('SELECT COUNT(*) AS n FROM transactions WHERE category=?', [src])) transactions = r.n;
        let allocations = 0;
        for (const r of this.qAll('SELECT COUNT(*) AS n FROM paycheck_allocations WHERE category=?', [src])) allocations = r.n;

        this.run('UPDATE transactions SET category=? WHERE category=?', [dst, src]);
        this.run('UPDATE paycheck_allocations SET category=? WHERE category=?', [dst, src]);
        // A card charge tag is a category reference too: after this merge, the
        // next payment for that charge must land in the surviving category.
        this.run('UPDATE credit_card_charges SET category=? WHERE category=?', [dst, src]);
        this.run('UPDATE credit_card_charge_parts SET category=? WHERE category=?', [dst, src]);

        // A saved check that paid both names now has two lines for the same
        // category: fold them into one so the split still shows once.
        for (const pk of this.qAll('SELECT DISTINCT paycheck_id FROM paycheck_allocations WHERE category=?', [dst])) {
            const rows = this.qAll('SELECT id, amount FROM paycheck_allocations WHERE paycheck_id=? AND category=? ORDER BY id', [pk.paycheck_id, dst]);
            if (rows.length < 2) continue;
            const total = rows.reduce((s, r) => s + r.amount, 0);
            this.run('UPDATE paycheck_allocations SET amount=? WHERE id=?', [round2(total), rows[0].id]);
            for (const r of rows.slice(1)) this.run('DELETE FROM paycheck_allocations WHERE id=?', [r.id]);
        }

        // Saved list: the old name goes, the survivor stays exactly once. If the
        // survivor was not listed yet it takes the old name's slot, so the order
        // does not jump around; otherwise the old slot is simply closed up.
        let envelopes = cur.envelopes.slice();
        const at = envelopes.findIndex(e => e.toLowerCase() === src.toLowerCase());
        const hasDst = envelopes.some(e => e.toLowerCase() === dst.toLowerCase());
        if (at >= 0) {
            if (hasDst) envelopes.splice(at, 1);
            else envelopes[at] = dst;
        }

        const keywords = Object.assign({}, cur.keywords);
        Object.keys(keywords).forEach(k => { if (keywords[k] === src) keywords[k] = dst; });

        // The savings page points at one category. If that category was just
        // merged away, the pointer follows its money rather than dangling.
        const savingsCategory = cur.savings_category && cur.savings_category === src ? dst : cur.savings_category;

        this.saveCfg({
            envelopes: envelopes,
            review_category: cur.review_category,
            keywords: keywords,
            savings_category: savingsCategory,
            savings_account_name: cur.savings_account_name
        });
        this._dirty();
        return { from: src, to: dst, transactions: transactions, allocations: allocations };
    },

    _saveConfig(body) {
        const cur = this.cfg();
        const next = {
            envelopes: body.envelopes !== undefined ? body.envelopes : cur.envelopes,
            review_category: body.review_category !== undefined ? body.review_category : cur.review_category,
            keywords: body.keywords !== undefined ? body.keywords : cur.keywords,
            savings_category: body.savings_category !== undefined ? body.savings_category : cur.savings_category,
            savings_account_name: body.savings_account_name !== undefined ? body.savings_account_name : cur.savings_account_name,
        };
        if (body.envelopes !== undefined) {
            // keep names tidy: strip empties, drop dupes case-insensitively
            const seen = new Set();
            next.envelopes = next.envelopes
                .map(e => String(e).trim())
                .filter(e => { if (!e) return false; const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
        }
        if (!next.review_category) next.review_category = DEFAULT_REVIEW;
        // Renaming the review category carries its waiting items across; the
        // Settings card promises this, and without it the items would be
        // stranded in a category the Review tab no longer looks at.
        if (next.review_category !== cur.review_category) {
            this.run('UPDATE transactions SET category=? WHERE category=?', [next.review_category, cur.review_category]);
            this.run('UPDATE paycheck_allocations SET category=? WHERE category=?', [next.review_category, cur.review_category]);
            this.run('UPDATE credit_card_charges SET category=? WHERE category=?', [next.review_category, cur.review_category]);
            // The savings pointer should never be the review bucket, but if an
            // imported file says otherwise, keep it consistent instead of
            // leaving it on a name that no longer exists.
            if (next.savings_category === cur.review_category) next.savings_category = next.review_category;
        }
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
    return {
        envelopes: [], review_category: DEFAULT_REVIEW, keywords: {},
        savings_category: '', savings_account_name: 'Savings account',
    };
}
