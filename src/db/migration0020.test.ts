import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * The 0020 provenance migration, exercised WITH DATA.
 *
 * `db.test.ts` proves every migration applies to an empty database, which is
 * precisely the case this one is uninteresting in: the schema statements are
 * generated, and the whole risk lives in the HAND-ADDED backfill. An empty
 * ledger backfills nothing and passes regardless.
 *
 * Leaving `simplefin_source_account_id` NULL on an existing sync row is not a
 * tidiness problem: `syncSimpleFin`'s id pass keys on that column, and the
 * content fallback's different-feed clause is `NULL <> feed`, which is NULL
 * rather than true. A row missed by the backfill is invisible to both passes
 * and re-imports on the very next sync — the exact double-count the migration
 * exists to remove.
 */
const MIGRATIONS = path.join(process.cwd(), "drizzle");

function statementsOf(file: string): string[] {
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Applies migrations in filename order, stopping AFTER `stopAfter`. */
function applyMigrations(sqlite: Database.Database, stopAfter: string): void {
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    for (const statement of statementsOf(file)) sqlite.exec(statement);
    if (file.startsWith(stopAfter)) return;
  }
  throw new Error(`No migration starting with ${stopAfter}`);
}

describe("0020 — backfilling transactions.simplefin_source_account_id", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    // Mirrors scripts/migrate.mjs (CLAUDE.md rule 7).
    sqlite.pragma("foreign_keys = OFF");
    applyMigrations(sqlite, "0019");
    sqlite.exec(`
      INSERT INTO import_batches (id, source, label, imported_at, transaction_count)
        VALUES (1, 'simplefin', 'simplefin.seed', unixepoch(), 0);
    `);
  });

  afterEach(() => {
    if (sqlite.open) sqlite.close();
  });

  function seedAccount(id: number, feedId: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO accounts
           (id, name, type, starting_balance_cents, starting_balance_date, simplefin_account_id)
         VALUES (?, ?, 'checking', 0, '2026-01-01', ?)`,
      )
      .run(id, `Account ${id}`, feedId);
  }

  function seedTxn(
    id: number,
    accountId: number,
    externalId: string | null,
    source: "csv" | "simplefin" | "manual" = "simplefin",
  ): void {
    sqlite
      .prepare(
        `INSERT INTO transactions
           (id, account_id, date, raw_description, raw_memo, normalized_merchant,
            amount_cents, import_source, import_batch_id, import_row_hash, external_id)
         VALUES (?, ?, '2026-05-01', 'WITHDRAWAL', ?, ?, -487, ?, 1, ?, ?)`,
      )
      .run(id, accountId, `MEMO ${id}`, `MEMO ${id}`, source, `hash-${id}`, externalId);
  }

  function applyTwenty(): void {
    const file = fs
      .readdirSync(MIGRATIONS)
      .find((f) => f.startsWith("0020") && f.endsWith(".sql"))!;
    for (const statement of statementsOf(file)) sqlite.exec(statement);
  }

  function provenance(): { id: number; feed: string | null }[] {
    return sqlite
      .prepare(
        `SELECT id, simplefin_source_account_id AS feed FROM transactions ORDER BY id`,
      )
      .all() as { id: number; feed: string | null }[];
  }

  it("tags every sync row with its account's feed, resolved per account", () => {
    seedAccount(1, "ACT-1");
    seedAccount(2, "ACT-2");
    seedTxn(10, 1, "TRN-a");
    seedTxn(11, 1, "TRN-b");
    seedTxn(12, 2, "TRN-c");

    applyTwenty();

    expect(provenance()).toEqual([
      { id: 10, feed: "ACT-1" },
      { id: 11, feed: "ACT-1" },
      { id: 12, feed: "ACT-2" },
    ]);
  });

  it("leaves CSV and manual rows untagged — provenance is a SimpleFIN fact", () => {
    // The `WHERE external_id IS NOT NULL` clause. Tagging a CSV row would make
    // it look like feed history the id pass could claim.
    seedAccount(1, "ACT-1");
    seedTxn(10, 1, null, "csv");
    seedTxn(11, 1, null, "manual");
    seedTxn(12, 1, "TRN-c");

    applyTwenty();

    expect(provenance()).toEqual([
      { id: 10, feed: null },
      { id: 11, feed: null },
      { id: 12, feed: "ACT-1" },
    ]);
  });

  it("leaves a tagged row on an UNLINKED account NULL (the state the migration declines to guess)", () => {
    // Unreachable by the migration's own argument — a pre-fix unlink cleared
    // external_id, so a row that still has one has never been through one — and
    // deliberately unguarded. Pinned because the consequence is silent: such a
    // row is invisible to both dedup passes (see sync.test.ts).
    seedAccount(1, null);
    seedTxn(10, 1, "TRN-a");

    applyTwenty();

    expect(provenance()).toEqual([{ id: 10, feed: null }]);
  });

  it("backfills nothing and breaks nothing on a ledger that never synced", () => {
    seedAccount(1, null);
    seedTxn(10, 1, null, "csv");

    applyTwenty();

    expect(provenance()).toEqual([{ id: 10, feed: null }]);
    expect(sqlite.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });

  it("swaps the unique index from (account, id) to (feed, id), backfill FIRST", () => {
    // Ordering is load-bearing: the index is built over final data, so a
    // genuine collision fails the migration loudly instead of being permitted
    // by NULL distinctness and surfacing later as a re-import.
    seedAccount(1, "ACT-1");
    seedAccount(2, "ACT-2");
    seedTxn(10, 1, "TRN-shared");
    seedTxn(11, 2, "TRN-shared");

    applyTwenty();

    const indexes = (
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).not.toContain("transactions_account_external_id_unique");
    expect(indexes).toContain("transactions_feed_external_id_unique");
    expect(indexes).toContain("transactions_feed_source_idx");

    // Same id under two different feeds is legal — a SimpleFIN id is unique
    // within its feed, never globally.
    expect(provenance()).toEqual([
      { id: 10, feed: "ACT-1" },
      { id: 11, feed: "ACT-2" },
    ]);
    // ...and the same id under the SAME feed is not. Inserted with the tag set,
    // the way the post-migration write path does: the index only binds rows
    // that CARRY provenance, since SQLite treats index NULLs as distinct.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO transactions
             (id, account_id, date, raw_description, raw_memo, normalized_merchant,
              amount_cents, import_source, import_batch_id, import_row_hash,
              external_id, simplefin_source_account_id)
           VALUES (12, 1, '2026-05-01', 'WITHDRAWAL', 'M', 'M', -487, 'simplefin', 1,
                   'hash-12', 'TRN-shared', 'ACT-1')`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("preserves every other column on the rows it touches", () => {
    seedAccount(1, "ACT-1");
    seedTxn(10, 1, "TRN-a");
    const before = sqlite
      .prepare(
        `SELECT id, account_id, date, amount_cents, raw_memo, external_id,
                import_source, import_batch_id, import_row_hash
         FROM transactions ORDER BY id`,
      )
      .all();

    applyTwenty();

    expect(
      sqlite
        .prepare(
          `SELECT id, account_id, date, amount_cents, raw_memo, external_id,
                  import_source, import_batch_id, import_row_hash
           FROM transactions ORDER BY id`,
        )
        .all(),
    ).toEqual(before);
  });
});
