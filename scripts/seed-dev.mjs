#!/usr/bin/env node
/**
 * Dev-only fixture data for driving the UI by hand.
 *
 * NOT part of the app and never imported by it. It exists because roughly
 * fifteen tasks in the liability-accounts plan verify "manually, with a
 * mortgage present", and a fresh ledger has nothing to look at — so those
 * verifications would otherwise be asserted rather than performed.
 *
 * Writes to $DATA_DIR (default ./data), so point it somewhere scratch:
 *
 *     DATA_DIR=./.context/seed node scripts/seed-dev.mjs
 *     DATA_DIR=./.context/seed pnpm dev
 *
 * REFUSES to run unless DATA_DIR is set explicitly, and refuses again if the
 * database it points at holds any ledger rows — so it cannot clobber a real
 * ledger by a mistyped or absent DATA_DIR.
 */
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dbPath, MIGRATIONS_FOLDER } from "./db-paths.mjs";

// Guard 1 — DATA_DIR must be deliberate. `dbPath()` falls back to ./data,
// which IS the real ledger; a script whose whole safety story is "point it
// somewhere scratch" must not silently default to the thing it must not touch.
if (!process.env.DATA_DIR) {
  console.error(
    "Refusing to seed: DATA_DIR is not set, which would target the real ledger.\n" +
      "Run it against a scratch directory instead:\n" +
      "    DATA_DIR=./.context/seed node scripts/seed-dev.mjs",
  );
  process.exit(1);
}

const file = dbPath();
fs.mkdirSync(path.dirname(file), { recursive: true });

const sqlite = new Database(file);

// Guard 2 — runs BEFORE migrate(), not after. This used to sit below the
// migration, which meant a mistyped DATA_DIR had already run drizzle's
// migrator against the real ledger by the time the refusal printed. That
// matters beyond ordering neatness: CLAUDE.md rule 7 requires table-rebuild
// migrations to go through scripts/migrate.mjs (foreign_keys OFF before the
// migrator's BEGIN, plus a VACUUM INTO snapshot), and this script calls the
// migrator directly. Rebuild migrations already exist here (0010, 0017).
//
// Counted across all three ledger tables, not just transactions: an account
// configured and feed-linked but not yet imported into has zero transactions
// and would have passed the old check, then collected duplicate fixture rows
// (accounts.name has no unique index).
for (const table of ["transactions", "accounts", "import_batches"]) {
  let count = 0;
  try {
    count = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } catch {
    // Table absent — a database that has never been migrated. That is the
    // expected state for a fresh scratch directory, so treat it as empty.
    continue;
  }
  if (count > 0) {
    console.error(
      `Refusing to seed: ${file} already has ${count} ${table} rows.\n` +
        `Point DATA_DIR at an empty directory instead.`,
    );
    process.exit(1);
  }
}

sqlite.pragma("foreign_keys = ON");
migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });

const now = new Date();
const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// Clamped to today: a future-dated row is excluded from the balance sum by
// rule 1's strict `>` on the anchor and would make the fixture disagree with
// itself on screen.
const dayOfMonth = (n) =>
  iso(new Date(now.getFullYear(), now.getMonth(), Math.min(n, now.getDate())));
const monthStartMinus = (days) => iso(new Date(now.getTime() - days * 86400000));
const unix = (d) => Math.floor(d.getTime() / 1000);

const insertAccount = sqlite.prepare(`
  INSERT INTO accounts (name, type, starting_balance_cents, starting_balance_date,
                        simplefin_account_id, credit_limit_cents, minimum_payment_cents,
                        balance_as_of, balance_source)
  VALUES (@name, @type, @cents, @date, @sfin, @limit, @minPayment, @asOf, @source)
`);
const insertBatch = sqlite.prepare(
  `INSERT INTO import_batches (source, label, transaction_count) VALUES (?, ?, ?)`,
);
// The migrations already seed the full category tree, so these are looked up
// by name rather than inserted — inserting collides with categories.name's
// unique index.
const categoryId = (name) => {
  const row = sqlite.prepare(`SELECT id FROM categories WHERE name = ?`).get(name);
  if (!row) throw new Error(`seed-dev: no seeded category named ${name}`);
  return row.id;
};
const insertTxn = sqlite.prepare(`
  INSERT INTO transactions (account_id, date, raw_description, raw_memo, normalized_merchant,
                            amount_cents, import_source, import_batch_id, import_row_hash,
                            category_id, transfer_pair_id)
  VALUES (@accountId, @date, @desc, @memo, @merchant, @cents, @source, @batchId, @hash,
          @categoryId, NULL)
`);
const insertPeriod = sqlite.prepare(`
  INSERT INTO budget_periods (category_id, year, month, allocated_cents)
  VALUES (?, ?, ?, ?)
`);

const accounts = {
  checking: insertAccount.run({
    name: "Checking", type: "checking", cents: 348219, date: monthStartMinus(75),
    sfin: "ACT-DEMO-CHK", limit: null, minPayment: null, asOf: null, source: null,
  }).lastInsertRowid,
  savings: insertAccount.run({
    name: "Savings", type: "savings", cents: 821004, date: monthStartMinus(75),
    sfin: "ACT-DEMO-SAV", limit: null, minPayment: null, asOf: null, source: null,
  }).lastInsertRowid,
  // A card with a limit and a minimum payment: gets the bar, the caption and
  // the Reconcile action (DS62, DS55).
  visa: insertAccount.run({
    name: "Visa", type: "credit", cents: -164800, date: monthStartMinus(40),
    sfin: null, limit: 500000, minPayment: 5000, asOf: null, source: "manual",
  }).lastInsertRowid,
  // A card with NO limit: no bar, but still a card — NOT filed under
  // LONG-TERM and NOT muted. This row is E7's regression, on screen.
  amex: insertAccount.run({
    name: "Amex", type: "credit", cents: -42350, date: monthStartMinus(3),
    sfin: null, limit: null, minPayment: null, asOf: null, source: "manual",
  }).lastInsertRowid,
  // Feed-linked, zero rows: offers Refresh, not Reconcile (E4), renders muted
  // under LONG-TERM (DS59), and shows a `feed`-threshold staleness label.
  mortgage: insertAccount.run({
    name: "Mortgage", type: "loan", cents: -30248011, date: monthStartMinus(9),
    sfin: "ACT-DEMO-LOAN", limit: null, minPayment: null,
    asOf: unix(new Date(now.getTime() - 9 * 86400000)), source: "feed",
  }).lastInsertRowid,
  // A long-term liability with NO feed link — a car loan. Must offer
  // Reconcile (it resolves to "reconcile", having no feed) but NOT "Add a
  // charge" (D3=A/E17 keep a loan at zero transaction rows). This row exists
  // because gating the balance control on `!longTerm` as well as on the
  // resolved action made it render NEITHER, leaving its balance permanently
  // unreachable: manualTransaction refuses a loan and /import's repair form
  // excludes every liability while pointing here.
  carLoan: insertAccount.run({
    name: "Car Loan", type: "loan", cents: -1850000, date: monthStartMinus(20),
    sfin: null, limit: null, minPayment: null, asOf: null, source: "manual",
  }).lastInsertRowid,
};

const csvBatch = insertBatch.run("csv", "seed.csv", 0).lastInsertRowid;
const manualBatch = insertBatch.run("manual", null, 0).lastInsertRowid;

const groceries = categoryId("Groceries");
const dining = categoryId("Dining");
const gas = categoryId("Gas");
const utilities = categoryId("Electric");
const fun = categoryId("Amazon");
const paycheck = categoryId("Paycheck");

const y = now.getFullYear();
const m = now.getMonth() + 1;

// "Closest to limit" needs four DISTINCT positions (T13/DS53): an overflow
// row, a row at exactly the amber threshold, an ordinary row, and a row with
// spend and no allocation at all.
insertPeriod.run(groceries, y, m, 50000);   // spend 60000 -> 120%, overflow badge
insertPeriod.run(dining, y, m, 20000);      // spend 16000 -> 80%, amber
insertPeriod.run(gas, y, m, 15000);         // spend 11850 -> 79%, ledger
insertPeriod.run(utilities, y, m, 30000);   // spend 4200 -> 14%
// `fun` deliberately gets NO budget_periods row but does get spend.

let hash = 0;
const txn = (accountId, date, cents, memo, categoryId, source = "csv", batchId = csvBatch) => {
  hash += 1;
  insertTxn.run({
    accountId, date, cents, categoryId, source, batchId,
    desc: cents < 0 ? "WITHDRAWAL" : "DEPOSIT",
    memo, merchant: memo, hash: `seed-${hash}`,
  });
};

txn(accounts.checking, dayOfMonth(2), 320000, "PAYROLL DIRECT DEP", paycheck);
txn(accounts.checking, dayOfMonth(4), -4200, "PGE UTILITIES", utilities);
txn(accounts.checking, dayOfMonth(6), -11850, "CHEVRON 1234", gas);
txn(accounts.checking, dayOfMonth(8), -16000, "OLIVE GARDEN", dining);
txn(accounts.checking, dayOfMonth(9), -30000, "SAFEWAY 0912", groceries);
txn(accounts.checking, dayOfMonth(11), -60000, "AMAZON MKTPLACE", fun);

// Card charges — real spend in their envelopes, in the month charged (D13=B).
txn(accounts.visa, dayOfMonth(12), -18000, "COSTCO WHSE 0455", groceries, "manual", manualBatch);
txn(accounts.visa, dayOfMonth(14), -12000, "TRADER JOES 118", groceries, "manual", manualBatch);

// A card payment: -500 on checking, +500 on the Visa, the two rows paired.
// Money-neutral, excluded from spend by the existing transfer_pair_id filter,
// and the source of DS58's "paid down" line.
txn(accounts.checking, dayOfMonth(15), -50000, "PAYMENT TO VISA", null, "manual", manualBatch);
txn(accounts.visa, dayOfMonth(15), 50000, "PAYMENT FROM CHECKING", null, "manual", manualBatch);
const payRows = sqlite
  .prepare(`SELECT id FROM transactions WHERE raw_memo LIKE 'PAYMENT %' ORDER BY id`)
  .all();
if (payRows.length === 2) {
  const link = sqlite.prepare(`UPDATE transactions SET transfer_pair_id = ? WHERE id = ?`);
  link.run(payRows[1].id, payRows[0].id);
  link.run(payRows[0].id, payRows[1].id);
}

// Two uncategorized rows so the backlog banner and Spine chip render.
txn(accounts.checking, dayOfMonth(16), -2400, "SQ *UNKNOWN VENDOR", null);
txn(accounts.checking, dayOfMonth(17), -899, "PADDLE.NET* SOMETHING", null);

const counts = sqlite.prepare(
  `SELECT import_batch_id AS b, COUNT(*) AS c FROM transactions GROUP BY import_batch_id`,
).all();
for (const { b, c } of counts) {
  sqlite.prepare(`UPDATE import_batches SET transaction_count = ? WHERE id = ?`).run(c, b);
}

const summary = sqlite.prepare(`SELECT name, type, starting_balance_cents FROM accounts`).all();
console.log(`Seeded ${file}`);
for (const a of summary) {
  console.log(`  ${a.name.padEnd(10)} ${a.type.padEnd(9)} ${(a.starting_balance_cents / 100).toFixed(2)}`);
}
sqlite.close();
