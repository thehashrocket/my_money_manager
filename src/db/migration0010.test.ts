import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Migration 0010 (`filename` NOT NULL → nullable `label`) is a full SQLite
 * table rebuild, not an in-place ALTER. Every other test in this repo runs
 * migrations against an empty `:memory:` DB (see `createTestDb`), so the
 * `INSERT INTO __new_import_batches ... SELECT ... CASE WHEN` line that
 * carries real pre-existing rows across the rebuild has never actually run
 * against non-empty data — a bug there would silently drop every user's real
 * CSV import filenames with no test catching it.
 *
 * This applies migrations 0000–0009 to build the OLD schema, seeds rows the
 * way the pre-migration app would have (every batch has a non-null
 * `filename`), then applies 0010 and checks what survived.
 */

const drizzleDir = path.join(process.cwd(), "drizzle");

function execMigration(sqlite: Database.Database, file: string): void {
  const content = fs
    .readFileSync(path.join(drizzleDir, file), "utf8")
    .replace(/-->\s*statement-breakpoint/g, "");
  sqlite.exec(content);
}

const PRE_0010_MIGRATIONS = [
  "0000_thin_mandroid.sql",
  "0001_complete_ikaris.sql",
  "0002_more_categories.sql",
  "0003_flimsy_micromacro.sql",
  "0004_chubby_the_spike.sql",
  "0005_subscriptions_category.sql",
  "0006_subscription_rules.sql",
  "0007_unique_lily_hollister.sql",
  "0008_naive_zeigeist.sql",
  "0009_narrow_sentinels.sql",
];

describe("migration 0010 (import_batches.filename -> label)", () => {
  it("preserves the real filename on a CSV batch and nulls it out on a sync batch", () => {
    const sqlite = new Database(":memory:");
    try {
      for (const file of PRE_0010_MIGRATIONS) {
        execMigration(sqlite, file);
      }

      // Pre-migration schema: `filename` is NOT NULL text on every batch,
      // including sync batches (which stored a synthetic
      // `simplefin {timestamp}` string — see the removed literal in
      // src/lib/simplefin/sync.ts).
      sqlite
        .prepare(
          `INSERT INTO import_batches (id, source, filename) VALUES (?, ?, ?)`,
        )
        .run(1, "csv", "starone-2026-01.csv");
      sqlite
        .prepare(
          `INSERT INTO import_batches (id, source, filename) VALUES (?, ?, ?)`,
        )
        .run(2, "simplefin", "simplefin 2026-01-01 00:00Z");

      execMigration(sqlite, "0010_flat_baron_zemo.sql");

      const rows = sqlite
        .prepare(`SELECT id, source, label FROM import_batches ORDER BY id`)
        .all() as { id: number; source: string; label: string | null }[];

      expect(rows).toEqual([
        { id: 1, source: "csv", label: "starone-2026-01.csv" },
        { id: 2, source: "simplefin", label: null },
      ]);
    } finally {
      sqlite.close();
    }
  });
});

/**
 * The rebuild in migration 0010 DROPs `import_batches`, which `transactions`
 * references via `import_batch_id ... onDelete: 'restrict'`. The test above
 * proves the CASE WHEN copy is correct, but it runs each migration file
 * through `sqlite.exec()` directly (autocommit) and never seeds a
 * `transactions` row — so it can't catch what `drizzle-orm`'s real migrator
 * does: wrap every pending migration in ONE `BEGIN`/`COMMIT`, inside which
 * `PRAGMA foreign_keys=OFF` (this migration's own first statement) is a
 * documented SQLite no-op. `PRAGMA defer_foreign_keys=ON` doesn't rescue it
 * either — SQLite's deferred-FK bookkeeping is a violation *counter*, not a
 * final-state check, and DROP TABLE on an FK parent increments it even when
 * the rebuilt table ends up satisfying every reference by commit time. With
 * better-sqlite3's compiled-in default of `foreign_keys=ON`, and at least one
 * real `transactions` row on the books (true the moment a single CSV import
 * or sync has ever run), `drizzle-kit migrate` — and `migrate()` called the
 * naive way — throws `FOREIGN KEY constraint failed` on the `DROP TABLE` and
 * leaves the database on the OLD schema. An empty dev database never
 * exercises this path, which is exactly why `pnpm db:migrate` looked fine
 * during development.
 *
 * `scripts/migrate.mjs` is the fix: it disables `foreign_keys` on the
 * connection BEFORE calling `migrate()`, so it's already off when the
 * migrator's own `BEGIN` opens rather than needing to change mid-transaction.
 * `package.json`'s `db:migrate` script now runs it instead of
 * `drizzle-kit migrate` directly. This test spawns the real script (not a
 * re-derivation of its logic) against a database seeded exactly the way a
 * real user's would be — an account, a CSV batch, a SimpleFIN batch, and a
 * `transactions` row on each — so a regression in the script itself fails
 * this test, not just a future copy of the same reasoning.
 */
describe("scripts/migrate.mjs against a database with real FK-referencing rows", () => {
  it("survives the 0010 rebuild without violating the transactions -> import_batches FK", () => {
    const repoRoot = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migrate0010-"));
    try {
      // A migrations folder containing only 0000-0009, so drizzle's real
      // migrate() can apply exactly the pre-0010 schema and record its own
      // bookkeeping — the same mechanism `scripts/migrate.mjs` relies on to
      // know which migrations are already applied.
      const realJournal = JSON.parse(
        fs.readFileSync(
          path.join(repoRoot, "drizzle", "meta", "_journal.json"),
          "utf8",
        ),
      ) as { entries: { idx: number; tag: string }[] };
      // Everything BEFORE 0010, not "everything except 0010". Drizzle's
      // migrator decides what to apply by timestamp, so leaving a later
      // migration in this folder would record it as applied and 0010 — the
      // rebuild this test exists to exercise — would be skipped entirely.
      const idx0010 = realJournal.entries.findIndex(
        (e) => e.tag === "0010_flat_baron_zemo",
      );
      expect(idx0010).toBeGreaterThan(-1);
      const pre0010Entries = realJournal.entries.slice(0, idx0010);

      const partialDir = path.join(tmpDir, "drizzle-pre0010");
      fs.mkdirSync(path.join(partialDir, "meta"), { recursive: true });
      fs.writeFileSync(
        path.join(partialDir, "meta", "_journal.json"),
        JSON.stringify({ ...realJournal, entries: pre0010Entries }),
      );
      for (const entry of pre0010Entries) {
        fs.copyFileSync(
          path.join(repoRoot, "drizzle", `${entry.tag}.sql`),
          path.join(partialDir, `${entry.tag}.sql`),
        );
      }

      const dbPath = path.join(tmpDir, "seeded.db");
      const seedSqlite = new Database(dbPath);
      seedSqlite.pragma("foreign_keys = ON");
      migrate(drizzle(seedSqlite), { migrationsFolder: partialDir });

      seedSqlite.exec(
        `INSERT INTO accounts (id, name, type, starting_balance_cents, starting_balance_date) VALUES (1, 'Checking', 'checking', 0, '2026-01-01')`,
      );
      seedSqlite.exec(
        `INSERT INTO import_batches (id, source, filename) VALUES (1, 'csv', 'starone.csv'), (2, 'simplefin', 'simplefin 2026-01-01 00:00Z')`,
      );
      seedSqlite.exec(
        `INSERT INTO transactions (id, account_id, date, raw_description, raw_memo, normalized_merchant, amount_cents, import_source, import_batch_id, import_row_hash) VALUES
          (1, 1, '2026-01-05', 'WITHDRAWAL', 'csv row', 'csv row', -100, 'csv', 1, 'hash1'),
          (2, 1, '2026-01-06', 'WITHDRAWAL', 'sync row', 'sync row', -200, 'simplefin', 2, 'hash2')`,
      );
      seedSqlite.close();

      // Run the REAL migration script exactly as `pnpm db:migrate` does,
      // against a cwd shaped like the real project: data/money.db + a
      // drizzle/ folder that includes 0010.
      const workDir = path.join(tmpDir, "project");
      fs.mkdirSync(path.join(workDir, "data"), { recursive: true });
      fs.symlinkSync(path.join(repoRoot, "drizzle"), path.join(workDir, "drizzle"), "dir");
      fs.copyFileSync(dbPath, path.join(workDir, "data", "money.db"));

      execFileSync("node", [path.join(repoRoot, "scripts", "migrate.mjs")], {
        cwd: workDir,
        stdio: "pipe",
      });

      const migrated = new Database(path.join(workDir, "data", "money.db"));
      try {
        const cols = migrated
          .prepare("PRAGMA table_info(import_batches)")
          .all() as { name: string; notnull: number }[];
        const labelCol = cols.find((c) => c.name === "label");
        expect(labelCol?.notnull).toBe(0);

        const rows = migrated
          .prepare("SELECT id, source, label FROM import_batches ORDER BY id")
          .all();
        expect(rows).toEqual([
          { id: 1, source: "csv", label: "starone.csv" },
          { id: 2, source: "simplefin", label: null },
        ]);

        migrated.pragma("foreign_keys = ON");
        expect(migrated.pragma("foreign_key_check")).toEqual([]);
      } finally {
        migrated.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * `scripts/migrate.mjs`'s whole reason for existing is the `PRAGMA
 * foreign_key_check` it runs after `migrate()` -- the belt-and-suspenders
 * catch for a rebuild that silently corrupted a reference. Every test above
 * only exercises the success path; this proves the alarm itself fires: a
 * real dangling reference, seeded independently of any pending migration,
 * must make the script exit non-zero rather than reporting success.
 */
describe("scripts/migrate.mjs — foreign_key_check failure path", () => {
  it("exits non-zero when a real FK violation exists, even with nothing left to migrate", () => {
    const repoRoot = process.cwd();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-migrate-fk-"));
    try {
      // Apply every real migration, so there is nothing pending for
      // migrate() to do -- isolating the FK check from the migration step.
      const dbPath = path.join(tmpDir, "seeded.db");
      const seedSqlite = new Database(dbPath);
      seedSqlite.pragma("foreign_keys = ON");
      migrate(drizzle(seedSqlite), { migrationsFolder: path.join(repoRoot, "drizzle") });

      seedSqlite.exec(
        `INSERT INTO accounts (id, name, type, starting_balance_cents, starting_balance_date) VALUES (1, 'Checking', 'checking', 0, '2026-01-01')`,
      );
      // A transaction pointing at an import_batch_id that does not exist --
      // requires foreign_keys off to insert at all, simulating a rebuild
      // that left a dangling reference behind.
      seedSqlite.pragma("foreign_keys = OFF");
      seedSqlite.exec(
        `INSERT INTO transactions (id, account_id, date, raw_description, raw_memo, normalized_merchant, amount_cents, import_source, import_batch_id, import_row_hash) VALUES
          (1, 1, '2026-01-05', 'WITHDRAWAL', 'dangling row', 'dangling row', -100, 'csv', 999, 'hash1')`,
      );
      seedSqlite.close();

      const workDir = path.join(tmpDir, "project");
      fs.mkdirSync(path.join(workDir, "data"), { recursive: true });
      fs.symlinkSync(path.join(repoRoot, "drizzle"), path.join(workDir, "drizzle"), "dir");
      fs.copyFileSync(dbPath, path.join(workDir, "data", "money.db"));

      let error: (Error & { status?: number; stderr?: Buffer }) | null = null;
      try {
        execFileSync("node", [path.join(repoRoot, "scripts", "migrate.mjs")], {
          cwd: workDir,
          stdio: "pipe",
        });
      } catch (err) {
        error = err as Error & { status?: number; stderr?: Buffer };
      }

      expect(error).not.toBeNull();
      expect(error?.status).toBe(1);
      expect(error?.stderr?.toString()).toMatch(/foreign_key_check found violations/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
