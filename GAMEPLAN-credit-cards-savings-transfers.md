# Game plan — Credit cards, Savings page, and Transfers

Three new features, one release. Written against the current code (v17) so each
phase is mostly mechanical:

1. **Transfers** — move money between categories (e.g. Savings → Food).
2. **Savings page** — shows the actual savings account balance at the bank;
   the Savings *category* is money still in checking that is set aside to go
   there, and transfers are what move it in or out.
3. **Credit cards page** — put card purchases in their own section while they
   are unpaid; when the card is paid, one button turns the bill into a normal
   transaction under a Credit Card category.

Savings builds on Transfers, so Transfers comes first. Credit cards is
independent and can land last.

---

## 0. Ground rules from the current app (why the designs look the way they do)

Facts that constrain every design decision below:

- **Money lives in envelopes.** A category's balance = `allocations in − expenses out`
  (`Backend.summary()` in `backend.js`). There is no "checking account" entity:
  the **Balance** badge is the sum of all category balances, which *is* the
  money in checking (every dollar in checking has already been assigned a job).
  Consequences:
  - "Transfer from checking to savings" really means "move money from one
    category to savings" — the From-category picker is required, not optional.
  - A credit-card payment is money leaving checking, so the budget total must
    drop by the amount paid. Charges that haven't been paid yet must *not*
    touch the budget until the payment happens.
- **The savings account is outside the checking budget.** The Balance badge
  counts checking money only. A real savings account at the bank is tracked
  as its own ledger on the Savings tab; money is *outside* the budget while
  it sits there. Moving money there is an outflow (the badge drops), moving
  it back is an inflow (the badge rises) — not a category-to-category
  transfer, which nets to zero.
- **One file, one source of truth.** Everything is in `budget.db` (SQLite via
  sql.js). Google Drive sync, the conflict guard, daily backups, and the
  12-second Undo all work at the *file* level (`app.js`: `saveNow`,
  `pushNow`, `offerUndo`). **New tables inside `budget.db` get all of that for
  free** — no `drive.js` changes, ever.
- **Splits are the pattern for "one event, several categories."** A parent row
  (`category = '__split__'`, constant `PARENT_MARKER`) with child rows; the
  parent is excluded from every category total, children are not; deleting the
  parent deletes the children. Transfers reuse this pattern exactly.
- **`transactions.source` already distinguishes system rows** (`'manual'`,
  `'carryover'`). New system rows will use `'transfer'`, `'cc_payment'`,
  `'savings'` (deposit to the account) and `'savings_withdrawal'`.
- **The report** (`Backend.report()`) counts `type='allocation'` rows with
  `parent_id IS NULL AND source != 'carryover'` as money received — any new
  top-level allocation rows must be excluded there or "income" inflates.
- **Migrations** run in `Backend._migrate()` when a DB file is loaded; new
  tables must be created there (old Drive files) and in `SCHEMA` (fresh DBs).
  `CREATE TABLE IF NOT EXISTS` is idempotent, so always-running the schema is
  safe.
- **Release = version bump in 3 places**: `?v=N` on the three script tags in
  `index.html`, `CACHE` name in `sw.js`, and the "App version N" text in
  Settings.

---

## 1. Feature 3 (built first): Transfers between categories

### 1.1 What it does

One small form (on the **Categories** tab, where the balances are):

> Move money: **From** [Savings ▾] → **To** [Food ▾]  Amount [50.00]  Date [today]
> Note (optional): [pay the food tab early]   **[Move]**
> Live preview: Food $450 → $500 · Savings $120 → $70 · Total unchanged

### 1.2 Data model — a transfer is a split-shaped pair

No new table. One transfer = one parent transaction + two child rows, using
the existing split mechanics:

| row | type | amount | category | parent_id | source |
|---|---|---|---|---|---|
| head | `allocation` | `+X` | `__split__` | — | `transfer` |
| child 1 | `allocation` | `+X` | destination (Food) | head.id | `transfer` |
| child 2 | `allocation` | `−X` | source (Savings) | head.id | `transfer` |

Why this works with zero changes to the money math:

- `summary()`: Food's `allocated` +X, Savings' `allocated` −X → each envelope
  moves, **total balance unchanged** (transfers move money between boxes, they
  don't create or destroy any).
- The head's category is `__split__`, which `categories()`/`activeCategories()`
  already exclude, so the head never appears as a phantom category.
- The Transactions tab already renders parent+children as a grouped pair
  (`rowHtml`/`childHtml` in `app.js`), so a transfer shows up as one block:
  `Transfer: Savings → Food` with the two legs underneath — visible history,
  one delete button kills the whole thing.
- Carrying a negative envelope already happens today (period close keeps
  negatives), so a transfer that pushes a category into the red is legal.

from/to are **derived from the signs of the children** (positive = to,
negative = from) — no extra columns needed. Description on the head:
`Transfer: Savings → Food` (+ " — note" if given).

### 1.3 Backend changes (`backend.js`)

- New route `POST /api/transfers` with body `{ from, to, amount, date, note }`:
  - validate: from/to non-empty and different; not `__split__`; not the review
    category (it has no balance — same rule `_mergeCategory` already applies);
    amount > 0; date `YYYY-MM-DD`.
  - insert head + 2 children as above, `source='transfer'`, then `_dirty()`.
    Return `{ id }` of the head.
- `report()`: add `AND source != 'transfer'` to the allocation-received clause
  (heads are `parent_id IS NULL` — without this, every transfer shows up as
  "income received"). Note: real income is counted by the separate
  `type='income'` query; top-level allocation rows are otherwise only
  carryovers, transfers, and savings withdrawals (2.3 excludes the last one
  from received as well).
- (Optional, same phase) `listTransactions`: support `type=transfer` →
  `source='transfer' AND parent_id IS NULL`, and a **Transfers** option in the
  Transactions filter select.

### 1.4 UI changes (`app.js`, `index.html`)

- New card "Move money between categories" at the top of `#tab-categories`:
  two `<select>`s filled from `categories` (each excluding the other's current
  value and the review category), amount/date/note inputs, Move button.
  `input` events update the preview line (read current `summary()` values).
- On success: 12-second **Undo** (DB snapshot, same as delete/merge), then
  `refreshApp()`.
- `loadTransactions` row rendering: if `t.source === 'transfer'`, label the
  category cell **Transfer** (instead of "Split"/"Income"), and **offer no ✎
  edit and no × delete on any of the three rows — the × lives on the head
  only.** This is not cosmetic: `_updateTransaction` rescales a head's
  children by *absolute* value and re-applies the type sign, so editing the
  head's amount would flip the −X leg to +X; editing one leg leaves the pair
  unbalanced; and a leg that lands on a later page renders as an "orphan" row
  (`orphanHtml`) that has its own × — deleting it would leave its partner
  standing and change the budget total. A wrong transfer is fixed by deleting
  the head (removes both legs, Undo offered) and adding it again. An "edit
  transfer" flow (delete + recreate behind a dialog) is a possible later
  refinement.

### 1.5 Verification (manual, `python3 -m http.server 8080`)

- [ ] Transfer 50 Savings → Food: Categories tab shows +50/−50, **top Balance badge unchanged**.
- [ ] Report for the month: "Income received" unchanged by the transfer.
- [ ] Transactions tab: grouped pair visible; deleting the head removes both legs and restores balances.
- [ ] Undo within 12 s reverts everything.
- [ ] Source going negative renders red like any other over-draft.
- [ ] Two devices: transfer on one, 10 s later visible on the other (polling).

**Commit 1** — transfer endpoint + UI + report clause + help text.

---

## 2. Feature 2 (built second): Savings page

### 2.1 What it is — two distinct things, kept separate

The model that shapes this section (confirmed 2026-11-17): the **Savings page
shows the money in your actual savings account at the bank**, not an envelope.
The budget's Savings **category** is a different thing — money still in
checking that is earmarked to go to that account. The page shows both and
keeps them linked:

```
Savings account (at the bank)            Savings category (in checking)
  the page's big number              ←→   "Ready to move" (envelope balance)
  changes only on deposit / withdraw       funded by income splits and
  recorded from this page                  set-aside transfers
```

Three verbs on the page, plus one correction tool:

1. **Set aside** — move money from another category into the Savings
   category. Net-zero on the budget (Feature 1's transfer). This is
   "storing it up to go to savings."
2. **Move to savings account** — the actual bank transfer: the Savings
   category pays out X (money leaves checking, so the budget total drops by
   X) and the account balance rises by X.
3. **Move back to checking** — the reverse: the account drops by X, and X
   lands in a category you pick (default: the Savings category), raising the
   budget total by X.
4. **Adjust balance** — starting out or reconciling with the bank (interest,
   a forgotten movement): record the difference with **no budget impact**,
   because the account is outside the checking budget.

Layout:

1. **Account card** — big balance (the event ledger's sum), account name
   (editable, default "Savings account"), buttons: Move to savings account ·
   Move back to checking · Adjust balance.
2. **Savings category card** — "Ready to move: $X" (the envelope's
   available), the **Set aside** mini-form (From category → Savings,
   amount/date/note), and a one-tap "Move the $X to the account" that opens
   the deposit dialog pre-filled. When the category is empty on first use,
   the card offers to create/pick it (2.2).
3. **History card** — every account event (deposit / withdrawal /
   adjustment) and every set-aside transfer involving the category, newest
   first, plus a small monthly summary (set aside, moved to the account,
   account change).

### 2.2 Data + config

```sql
CREATE TABLE IF NOT EXISTS savings_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('deposit','withdrawal','adjust')),
    amount REAL NOT NULL,            -- signed: deposit > 0, withdrawal < 0, adjust ±
    note TEXT,
    tx_id INTEGER,                   -- the budget transaction; deliberately NOT a FK
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- **Balance = SUM(amount)** — derived, never cached. Same reasoning as the
  credit-card log: delete a transaction and the next read recomputes.
- `tx_id` is not a FK: period close wipes transactions and the account
  history must survive it (it records money that already moved at the bank).
- Config: `savings_category` (the staging envelope) and
  `savings_account_name` (display name). The pointer is rewritten on
  merge/rename like every other category reference (see §4).
- Migration: add the table to `SCHEMA`, and make `_migrate()` run
  `_runSchema()` unconditionally (see 3.2 for why). **That migration change
  belongs in Commit 2** — it is the first commit that adds a table, and
  without it an existing Drive file never gets `savings_events`.

### 2.3 The movements, exactly

| action | budget row | savings event | budget total | account |
|---|---|---|---|---|
| Set aside (category → Savings) | transfer pair (Feature 1) | — | unchanged | unchanged |
| Move to savings account | `expense`, `source='savings'`, category = Savings, −X | `deposit` +X | −X | +X |
| Move back to checking | `allocation`, `source='savings_withdrawal'`, category = chosen, +X | `withdrawal` −X | +X | −X |
| Adjust balance | — (no transaction) | `adjust` ±difference | unchanged | → the number typed |

- A deposit larger than the Savings category leaves the category negative —
  allowed with the red warning (decision 4); it honestly says "you moved
  more than you had set aside."
- A withdrawal is refused above the recorded account balance (an account
  can't go below zero); **Adjust balance** is the escape hatch if the
  records drifted from the bank.
- **Report:** a deposit must not read as spending and a withdrawal must not
  read as income. `report()` excludes `source='savings'` from the expense
  total and `source='savings_withdrawal'` from received, and returns a small
  `savings: { to, from }` object that the Report tab shows as its own line
  ("Moved to savings / from savings").
- `summary()` is **untouched**: the deposit's expense row debits the Savings
  envelope exactly like any expense — that is what makes "Ready to move" go
  down. Only the *report* treats saving as not-spending; do not add the
  exclusion to `summary()`.
- These rows are **read-only in the Transactions tab** (no ✎; × allowed),
  and `_deleteTransaction` deletes the matching `savings_events` row, so
  deleting the transaction moves the account back — same pattern as credit
  cards. Undo is offered as usual.
- Period close: events and the account balance survive (no FK, 2.2); the
  category carries over like any envelope.

### 2.4 Backend routes

| route | body | effect |
|---|---|---|
| `GET /api/savings` | — | name, balance, category + its available, recent events, recent set-asides |
| `PATCH /api/savings` | `{ name?, category? }` | rename account / pick the staging category |
| `POST /api/savings/deposit` | `{ amount, date, note? }` | validate 0 < amount; create the expense (`source='savings'`) + `deposit` event |
| `POST /api/savings/withdraw` | `{ amount, date, category, note? }` | validate 0 < amount ≤ balance; create the allocation (`source='savings_withdrawal'`) + `withdrawal` event |
| `POST /api/savings/adjust` | `{ balance, date, note? }` | record `typed − computed` as an `adjust` event (no transaction) |

Set aside uses `POST /api/transfers` (Feature 1). `_deleteTransaction` gains
a second hook: when deleting a top-level row with
`source IN ('savings','savings_withdrawal')`, delete its `savings_events`
row before the transaction goes.

### 2.5 UI + help

- New nav link **Savings** (after Transactions) plus the three registration
  points: the nav `<li>` in `index.html`, the hard-coded panel list in the tab
  click handler, and a visible-tab loader in `refreshApp()`.
- Dialogs in the split/edit modal style; the deposit dialog pre-fills the
  "ready to move" amount and warns if the category would go red.
- Help card: *"Your savings account is not part of the checking budget. Set
  money aside in the Savings category while it is still in checking; when
  you move it to the account, this page's balance goes up and the category
  goes down. Move it back when you need it — the app records both ends."*

### 2.6 Verification

- [ ] Set aside 100 (Fun → Savings): envelope moves, **total unchanged**, transfer pair in Transactions, account balance untouched.
- [ ] Move 100 to the account: account +100, Savings category −100, pocket total −100, "Move to savings account" row in Transactions, Report "spent" unchanged and the new "moved to savings" line +100.
- [ ] Move 40 back to Fun: account −40, Fun +40, total +40, Report "received" unchanged and "from savings" line −40.
- [ ] Adjust to the bank's real balance: account shows the typed number, difference recorded as an adjustment, budget totals unchanged.
- [ ] Delete the deposit transaction: account goes back down, Savings category restored, totals agree again.
- [ ] Period close: account balance and events survive; Savings category carries over.
- [ ] Account name rename and staging-category pick persist (config); merging the staging category moves the pointer.
- [ ] Undo works on every savings action.

**Commit 2** — savings ledger + three route groups + Savings tab + config
keys + report lines + help text.

---

## 3. Feature 1 (built third): Credit cards page

### 3.1 What it does

A new **Credit Cards** tab:

- While the month runs, card purchases go **here only** — they don't touch
  envelopes, the balance badge, or the report.
- Each card shows its **amount still owed** (big number) and the list of
  unpaid charges (date, description, amount, optional category tag, delete).
- **Pay card** button → a small dialog:
  > Still owed: **$432.18** · Amount to pay: [432.18] (editable — partial
  > payments allowed) · Date: [today]
  > This payment will go to transactions as: **Food −$210.00, Gas −$122.18,
  > Credit Card −$100.00**
  > **[Send to transactions]**

  On confirm: a normal expense transaction is created (the money leaves
  checking, so the total budget drops), the payment is logged against the
  card, and Undo is offered for 12 s. The card page then shows the remaining
  balance (0 → "All caught up ✓"). There is no automatic month-end trigger —
  you press the button when the statement arrives, which is exactly the
  manual flow requested.

### 3.2 Data model — new tables in the same file

```sql
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
    category TEXT,                    -- optional envelope tag (nullable)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cc_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
    tx_id INTEGER,                    -- transaction that carried the money; deliberately NOT a FK
    date TEXT NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0)
);
```

- Charges live in their own table so they stay invisible to every
  existing query (summary, report, transactions list, hints, merge) until the
  payment converts them into a real transaction.
- **What is paid is computed, never cached.** `owed = max(0, SUM(charges) −
  SUM(payments))`; each charge's status comes from a deterministic replay:
  payments in `(date, id)` order consume charges in `(date, id)` order.
  `GET /api/credit-cards` returns each charge with its consumed portion and
  status ("Unpaid", "Part paid $x of $y", "Paid by <date>").
- **Why no `paid_amount`/`paid_at` columns:** a cached stamp plus a deleted
  payment transaction drifts — the card would say paid while the budget got
  its money back. With the log, deleting the payment transaction removes its
  log row (`_deleteTransaction` hook, 3.4) and the next read recomputes the
  truth. Editing a payment's parts cannot desync anything either: the log is
  the record of money applied to the card.
- **Why `tx_id` is not a foreign key with cascade:** period close wipes all
  transactions. A cascade would delete the payment log and suddenly show the
  whole statement as unpaid again. The log must outlive transaction detail —
  it records money that already left checking, and the carryover balances
  already reflect it. So `_closePeriod` leaves the card tables alone and the
  paid state survives the close.
- Strictness: a charge may be edited or deleted only while no payment has
  consumed it (checked via the replay); once consumed it is history.
- Migration: the three tables join `SCHEMA` (fresh DBs) and are created on
  existing files by the `_migrate()` change introduced in Commit 2 (it runs
  the whole schema unconditionally; every statement is `IF NOT EXISTS`). Old
  Drive files get the tables on load; a new app reading an old file and an
  old app reading a new file are both safe (extra/missing tables are inert in
  SQLite).

### 3.3 The payment transaction

- Category: a charge's optional **tag** (picked from the real categories when
  it's entered). At payment time, the consumed charges are grouped by
  `tag || 'Credit Card'` — untagged charges fall into a plain **"Credit Card"**
  category, which is exactly the "sends it to transactions under credit card"
  behavior for anyone who doesn't tag.
  - One group → single expense transaction:
    `Credit card payment — <card name>`, `type='expense'`, `source='cc_payment'`,
    category = that group.
  - More than one group → same transaction, then split it with the existing
    split machinery (extract `_splitTransaction`'s core into a helper
    `_applySplit(id, parts, source)` used by both the manual-split route and
    the payment; the legs keep `source='cc_payment'`). The parent shows as a
    split in the Transactions tab, one leg per category — the envelopes get
    debited exactly where the spending happened. Group totals are computed in
    cents and the largest group absorbs the rounding remainder, so the legs
    sum to the payment amount to the cent (the split validator would tolerate
    1¢, but exact is cheaper than a mystery penny).
- Payment transactions are **read-only in the Transactions tab** (no ✎ on the
  head or the legs; × on the head only), for the same reason as transfers: the
  log is what keeps the card and the budget agreeing. To fix a wrong payment,
  delete it — the log row goes, the charges return to unpaid, Undo is
  offered — and pay again.
- Because it's a normal expense, the **Report picks it up automatically** and
  the Categories tab shows the envelopes drained (or a red "Credit Card"
  envelope if everything was untagged — that *is* the budget telling you the
  money left checking; the Help text explains it).
- Period close is unaffected: unpaid charges survive the wipe (separate
  table) — an unpaid card still owed in the new period just waits — and
  *paid* charges stay paid because `cc_payments` is not tied to the wiped
  transaction rows (see 3.2). Add one line to the close form when owed > 0:
  *"Note: $X still owed on <card> — it will wait until you pay."*

### 3.4 Backend routes (all in `Backend.api`)

| route | body | effect |
|---|---|---|
| `GET /api/credit-cards` | — | cards, each with `owed`, `last_payment_date`, charges with computed status |
| `POST /api/credit-cards` | `{ name }` | create card (first-visit auto-creates one, name "Credit card") |
| `PATCH /api/credit-cards/:id` | `{ name }` | rename |
| `DELETE /api/credit-cards/:id` | — | delete card + its charges (UI confirms; refuses if owed > 0) |
| `POST /api/credit-cards/:id/charges` | `{ date, description, amount, category? }` | add charge (validates amount > 0, date format) |
| `PATCH /api/credit-cards/:id/charges/:chargeId` | `{ description?, date?, amount?, category? }` | edit charge (only while no payment has consumed it — checked via the replay; once consumed it is history) |
| `DELETE /api/credit-cards/:id/charges/:chargeId` | — | delete charge (same rule; UI offers Undo) |
| `GET /api/credit-cards/:id/preview?amount=X` | — | the grouped split a payment of X would produce (same FIFO walk), so the dialog previews partial amounts without duplicating the algorithm in the browser |
| `POST /api/credit-cards/:id/pay` | `{ amount, date }` | validate `0 < amount ≤ owed + 0.01`; create the expense (+split per 3.3); insert a `cc_payments` row (`tx_id` = the transaction, `amount`); return `{ txId, groups: [{category, amount}], remaining }` |

Two wiring details:

- `_deleteTransaction` gains one hook: when the row being deleted is a
  **top-level** `source='cc_payment'` transaction (`parent_id IS NULL`),
  delete its `cc_payments` row before the transaction goes; the next card
  read recomputes the charges.
- The `api()` query parser whitelists only
  `type|category|q|date_from|date_to|limit|offset|month` — add `amount` for
  the preview route.

### 3.5 UI changes

- New nav link **Credit Cards** (after Savings), new `#tab-credit-cards`,
  same three registration points as the Savings tab.
- One card per credit card (v1: single card is enough; the table already
  allows more, "+ Add card" button can appear later without a schema change).
- Add-charge form at the top of the card: Date, Description, Amount,
  Category tag *(optional — "where did this spend belong? Food, Gas…")*.
  Category tag datalist = current categories (reuse the hint datalist style).
- Charge list: date · description · amount · tag badge · status
  (Unpaid / Part paid $x of $y / Paid by <date>) · edit and delete only while
  untouched by any payment (with Undo).
- Pay card button (disabled at owed = 0) opens a Bootstrap modal modeled on
  the existing split/edit modals: read-only "still owed", editable amount
  (defaults to owed, min 0.01, max owed), date, the split preview table
  (from the preview route), confirm button. After success: success line,
  Undo, `refreshApp()`.
- Like transfers, `source='cc_payment'` rows are read-only in the
  Transactions tab (✎ hidden on head and legs, × on the head only).
- Help tab: card explaining the workflow ("put card purchases here as they
  happen → tag them with the real category if you like → pay the card at the
  end of the month and it lands in Transactions").

### 3.6 Verification

- [ ] Enter 3 untagged + 2 tagged charges; balance badge and Report untouched.
- [ ] Pay full: one transaction (split if tags present) appears in Transactions;
      envelopes debited per tag; untagged part in "Credit Card" category; total
      balance drops by the payment; card shows owed $0 and every charge paid.
- [ ] Pay partial (half): oldest charges consumed first; remainder stays;
      second payment consumes the rest; both payments visible in Transactions.
- [ ] Undo right after a payment removes the transaction and un-pays the charges.
- [ ] Delete the payment transaction from the Transactions tab: the card's owed
      goes back up, the consumed charges return to unpaid (log replay), and the
      budget total goes back up — card and budget still agree.
- [ ] New period with an unpaid card: charges survive the close; warning line
      appears in the close form. **Paid charges stay paid after the close**
      (the payment log outlives the wiped transaction detail).
- [ ] Merge the category a charge is tagged with: the tag (and the savings
      pointer, if it was Savings) follows the merge; a later payment lands in
      the surviving category.
- [ ] Rename/delete card; delete a charge (unconsumed only); editing a consumed
      charge is refused.
- [ ] Fresh DB (Start fresh) has the tables; old DB file (pulled from Drive)
      gets them on load.

**Commit 3** — credit cards: tables + migration, routes, tab, pay dialog,
close-form warning, help text.

---

## 4. Cross-cutting items

- **Help tab** — one short card per feature, same plain style as the rest
  (the existing guide reads for a non-technical user; keep it that way).
  Glossary: add *Transfer* and *Credit card*.
- **Landing screen** "how to use" steps — no changes needed (the new tabs are
  optional add-ons to the same workflow).
- **`AGENTS.md`** — after the release: data model section gains the transfer
  pair convention, the savings ledger and its two config keys
  (`savings_category`, `savings_account_name`), and the four new tables
  (credit cards, card charges, card payments, savings events); note that new
  tables ride in `budget.db` so sync/backup/undo are unchanged.
- **Category lifecycle is a three-way concern now.** `_mergeCategory` and the
  review-category rename in `_saveConfig` must also rewrite
  `credit_card_charges.category` and the `savings_category` pointer — and
  rewrite any charge tag that names a category the merge removed. If a tag
  ever points at a name that no longer exists, the payment falls back to
  "Credit Card" rather than resurrecting the dead category.
- **Optional polish:** exclude `source IN ('transfer','cc_payment')` from
  `hints()` so "Credit card payment — VISA" never becomes a description
  suggestion in the datalist.
- **Sync/Drive: deliberately zero changes.** All new state is inside
  `budget.db`; file-level sync, conflict guard, polling, daily backups and
  snapshot Undo cover it. The only sync-adjacent risk is a mid-release mix of
  old/new devices, which the "additive-only migration" rule handles (never
  drop or rename tables/columns).
- **No money leaks by construction:** category-to-category transfers net to
  zero; a card payment is an expense equal to the money that left checking; a
  savings deposit is an expense equal to the money that left checking for the
  bank; a withdrawal is an allocation equal to the money that came back. The
  savings *account* balance lives outside the badge and is derived from its
  own ledger, so the badge stays exactly "money in checking".

## 5. Release procedure (after commit 3)

1. Bump version 17 → 18: `?v=18` on the three script tags in `index.html`,
   `CACHE = 'roux-budget-web-v18'` in `sw.js`, "App version 18" in Settings.
   `PRECACHE` list unchanged (no new files).
2. Update `AGENTS.md`.
3. Push with the one-shot token URL from AGENTS.md (token redacted in output),
   `git update-ref refs/remotes/origin/main HEAD`.
4. After the Pages deploy: check the live site with a hard reload; signed-in
   devices pick up the new version via the service worker update banner.

## 6. Decided (confirmed 2026-11-17)

1. **Credit card payment shape: hybrid.** Untagged charges → single
   "Credit Card" expense; tagged charges → payment splits into the real
   categories.
2. **Partial card payments: allowed.** Remaining balance carries to the next
   payment; charges consumed oldest first (FIFO).
3. **Savings scope: one savings account**, tracked as its own ledger on the
   Savings tab (`savings_events`), with the Savings category as the staging
   envelope in checking. Multiple accounts later = an additive `account_id`
   column plus a picker; the page already treats balance as a sum.
4. **Transfers into the red: allowed** (consistent with over-drafts and
   negative carryovers today), with a red preview warning.

## 7. Design review (2026-11-17) — what the double-check caught

Re-read against `backend.js` / `app.js` before implementation. The money model
holds up: a transfer pair nets to zero in `summary()`, stays out of the
report's income and expense totals, and survives period close like any other
carryover; a card payment is a plain expense and lands in the report normally.
Five real gaps were found and are folded into the sections above:

1. **Transfers were corruptible through the generic edit UI.**
   `_updateTransaction` rescales a head's children by absolute value and
   re-applies the type sign, so editing a transfer head's amount would turn
   its −X leg into +X; leg rows that land on another page render as orphans
   with their own delete button. Fixed: no edit/delete anywhere on a transfer
   except delete on the head (1.4).
2. **Card paid-state was cached, so history edits would desync it** (delete
   the payment transaction and the card would still look paid). Replaced by a
   `cc_payments` log with derived FIFO state (3.2, 3.4).
3. **A cascade FK from the payment log to `transactions` would have broken
   period close** — `_closePeriod` wipes transactions, which would have
   deleted the log and shown the whole statement unpaid again. The log now
   outlives transaction detail (3.2, 3.3).
4. **Merge/rename did not know about new category references** — a merged
   category would reappear from a stale charge tag, and the savings pointer
   could dangle. Both are rewritten in the existing merge/rename paths (2.2,
   4).
5. **Smaller wiring traps:** the tab click handler has a hard-coded panel list
   (a tab missing from it never hides — 2.5); the `api()` query parser has a
   fixed key whitelist (`amount` must be added for the preview route — 3.4);
   payment-split group totals must be computed in cents so the legs sum
   exactly (3.3).
6. **The savings model was corrected the same day (user feedback).** The page
   is the *bank account*, not the envelope — the Savings category is the
   staging area in checking, and "move to the account" is a real outflow (the
   badge drops), not a net-zero transfer. This is why 2.3 has both a
   category-to-category transfer (set aside) and an expense/income pair
   (deposit/withdrawal), why the account ledger is `savings_events` with no
   cascade FK to transactions (period close), and why the report grows two
   "moved to/from savings" lines instead of treating saving as spending.

Scope verdict: still three commits, no `drive.js` changes, no schema change to
`transactions`/`paychecks`/`app_config` (the config JSON gains two keys), and
every new table is additive — so old and new devices can share a Drive file
during the release without losing anything.

The SQL was also executed against a real SQLite engine (Node's built-in
`node:sqlite`, since this host has no `sqlite3` CLI) using the exact
`summary()` and `report()` queries: transfer legs net to zero across real
categories, the report's received total is unchanged by a transfer with the
`source != 'transfer'` clause (and inflated by $50 without it), the split
parent stays out of the spent total, and the FIFO replay produces the expected
partial payment, full payment, payment-deletion restore, and period-close
survival behavior. The corrected savings flow was checked the same way: set
aside nets to zero; a deposit debits the envelope and the checking total and
raises the account; a withdrawal does the reverse; an adjustment moves the
account and nothing else; deleting a deposit row restores the envelope and
lowers the account by the same amount; and the ledger survives period close.
All checks passed.
