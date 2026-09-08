import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * The 0019 rejection-store migration, exercised WITH DATA.
 *
 * `db.test.ts` already proves every migration applies to an empty database.
 * That is exactly the case this migration is uninteresting in: 0019 rebuilds
 * `transactions` to drop `transfer_rejected_partner_id` and replaces it with
 * the `transfer_pair_rejections` table, and the whole risk lives in the
 * hand-written data migration that carries the old column's contents across
 * the rebuild. An empty ledger backfills nothing and passes regardless.
 *
 * Every row in that column is a correction the user made by hand ("these two
 * are not a transfer"). Losing one silently re-arms the automatic matcher
 * against a pairing they already rejected, which drops both rows out of every
 * spending total with no error — so the backfill gets its own test rather than
 * riding on the schema-shape one.
 */
const MIGRATIONS = path.join(process.cwd(), "drizzle");

/** Applies migrations in filename order, stopping AFTER `stopAfter`. */
function applyMigrations(sqlite: Database.Database, stopAfter: string): void {
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) sqlite.exec(trimmed);
    }
    if (file.startsWith(stopAfter)) return;
  }
  throw new Error(`No migration starting with ${stopAfter}`);
}

describe("0019 — transfer_rejected_partner_id → transfer_pair_rejections", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    // Mirrors scripts/migrate.mjs (CLAUDE.md rule 7): this migration rebuilds
    // a table that is the target of foreign keys, so FKs are off for the run.
    sqlite.pragma("foreign_keys = OFF");
    applyMigrations(sqlite, "0018");
  });

  afterEach(() => {
    if (sqlite.open) sqlite.close();
  });

  function seedLedger(): { a: number; b: number; c: number; d: number } {
    sqlite.exec(`
      INSERT INTO accounts (id, name, type, starting_balance_cents, starting_balance_date)
        VALUES (1, 'Checking', 'checking', 0, '2026-01-01');
      INSERT INTO import_batches (id, source, label, imported_at, transaction_count)
        VALUES (1, 'csv', 'x.csv', unixepoch(), 4);
    `);
    const insert = sqlite.prepare(
      `INSERT INTO transactions
         (id, account_id, date, raw_description, raw_memo, normalized_merchant,
          amount_cents, import_source, import_batch_id, import_row_hash)
       VALUES (?, 1, '2026-05-01', 'WITHDRAWAL', ?, ?, ?, 'csv', 1, ?)`,
    );
    insert.run(10, "A", "A", -5000, "h10");
    insert.run(11, "B", "B", 5000, "h11");
    insert.run(12, "C", "C", -5000, "h12");
    insert.run(13, "D", "D", 5000, "h13");
    return { a: 10, b: 11, c: 12, d: 13 };
  }

  function applyNineteen(): void {
    const file = fs
      .readdirSync(MIGRATIONS)
      .find((f) => f.startsWith("0019") && f.endsWith(".sql"))!;
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) sqlite.exec(trimmed);
    }
  }

  function rejections(): { low: number; high: number }[] {
    return sqlite
      .prepare(
        `SELECT low_transaction_id AS low, high_transaction_id AS high
         FROM transfer_pair_rejections ORDER BY low, high`,
      )
      .all() as { low: number; high: number }[];
  }

  it("carries a mutually-marked rejection across the rebuild, exactly once", () => {
    const { a, b } = seedLedger();
    // How unlinkTransferPair wrote it: both legs pointed at each other, so the
    // same fact was stored twice and must not arrive as two rows.
    sqlite
      .prepare(`UPDATE transactions SET transfer_rejected_partner_id = ? WHERE id = ?`)
      .run(b, a);
    sqlite
      .prepare(`UPDATE transactions SET transfer_rejected_partner_id = ? WHERE id = ?`)
      .run(a, b);

    applyNineteen();

    expect(rejections()).toEqual([{ low: a, high: b }]);
  });

  it("normalises to (low, high) regardless of which leg held the marker", () => {
    const { a, b, c, d } = seedLedger();
    // Only the HIGHER id points at the lower one — the half of the old `a->b OR
    // b->a` disjunction that a naive `SELECT id, partner` backfill would store
    // backwards, silently missing on every subsequent lookup.
    sqlite
      .prepare(`UPDATE transactions SET transfer_rejected_partner_id = ? WHERE id = ?`)
      .run(a, b);
    sqlite
      .prepare(`UPDATE transactions SET transfer_rejected_partner_id = ? WHERE id = ?`)
      .run(d, c);

    applyNineteen();

    expect(rejections()).toEqual([
      { low: a, high: b },
      { low: c, high: d },
    ]);
  });

  it("drops the old column and keeps every transaction row intact", () => {
    seedLedger();
    const before = sqlite
      .prepare(`SELECT id, amount_cents, raw_memo FROM transactions ORDER BY id`)
      .all();

    applyNineteen();

    const columns = sqlite
      .prepare(`PRAGMA table_info(transactions)`)
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain("transfer_rejected_partner_id");
    expect(
      sqlite.prepare(`SELECT id, amount_cents, raw_memo FROM transactions ORDER BY id`).all(),
    ).toEqual(before);
    // The staging table is scaffolding, not schema.
    const tables = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain("__rejection_backfill");
  });

  it("leaves no rejections when none were recorded", () => {
    seedLedger();
    applyNineteen();
    expect(rejections()).toEqual([]);
  });

  it("survives with foreign keys enforced afterwards", () => {
    const { a, b } = seedLedger();
    sqlite
      .prepare(`UPDATE transactions SET transfer_rejected_partner_id = ? WHERE id = ?`)
      .run(b, a);

    applyNineteen();

    sqlite.pragma("foreign_keys = ON");
    // The belt-and-braces check scripts/migrate.mjs runs after every migration.
    expect(sqlite.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    // And the new table's cascade is live: deleting a leg takes the rejection.
    sqlite.prepare(`DELETE FROM transactions WHERE id = ?`).run(a);
    expect(rejections()).toEqual([]);
  });
});
