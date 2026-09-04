#!/usr/bin/env node
/**
 * Applies pending Drizzle migrations to data/money.db.
 *
 * Not `drizzle-kit migrate`: that CLI opens its own connection with
 * `foreign_keys` at SQLite's compiled-in default (ON for better-sqlite3),
 * and drizzle's migrator wraps every pending migration in one BEGIN/COMMIT.
 * `PRAGMA foreign_keys=OFF` inside a migration's own SQL is therefore a
 * documented no-op (SQLite only honors that pragma outside a transaction),
 * and `defer_foreign_keys=ON` doesn't help either -- it defers the check to
 * COMMIT, but SQLite's deferred-FK bookkeeping is a violation *counter*, not
 * a final-state check, and DROP TABLE on an FK parent increments it even
 * when the replacement table ends up satisfying every reference. A rebuild
 * migration (the only way SQLite relaxes a NOT NULL constraint) that DROPs a
 * table other tables reference via `onDelete: 'restrict'` -- import_batches,
 * here -- fails the moment real rows exist, which an empty dev database
 * never catches. Verified against a seeded scratch DB before adopting this.
 *
 * Fix: disable `foreign_keys` on the connection BEFORE calling migrate(), so
 * it's already off when the migrator's BEGIN opens rather than needing to
 * change state mid-transaction. `foreign_key_check` afterward is a
 * belt-and-suspenders integrity check -- it works regardless of the
 * `foreign_keys` pragma setting, so there is nothing to restore on this
 * connection before it closes.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dbPath, MIGRATIONS_FOLDER as MIGRATIONS_FOLDER_REL } from "./db-paths.mjs";

const DB_PATH = dbPath();
const MIGRATIONS_FOLDER = path.join(process.cwd(), MIGRATIONS_FOLDER_REL);

/**
 * A rebuild migration is at least as destructive as an import (it drops and
 * recreates a table), so it gets the same pre-write snapshot CLAUDE.md rule
 * 5 requires elsewhere -- via `VACUUM INTO` through a readonly connection
 * (matching src/lib/snapshot.ts), not a bare file copy, so a commit resident
 * only in money.db-wal isn't silently missing from it. Skipped when there's
 * no database yet (first-ever migrate run): nothing to protect.
 */
function snapshotBeforeMigrate(dbPath) {
  if (!existsSync(dbPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = `${dbPath}.pre-migrate-${stamp}`;
  const src = new Database(dbPath, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  return snapshotPath;
}

const snapshotPath = snapshotBeforeMigrate(DB_PATH);
if (snapshotPath) {
  console.log(`Snapshot written before migrating: ${snapshotPath}`);
}

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = OFF");

let migrationError = null;
try {
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
} catch (err) {
  migrationError = err;
}

// Always run the integrity check, even after a failed migration -- a
// partially-applied rebuild is exactly when a dangling reference is most
// likely. Checked before the process exits so a violation is never left for
// someone to notice later.
const violations = sqlite.pragma("foreign_key_check");
sqlite.close();

if (migrationError) {
  console.error("Migration failed:", migrationError);
  if (violations.length > 0) {
    console.error("Additionally, foreign_key_check found violations after the failed migration:", violations);
  }
  process.exitCode = 1;
} else if (violations.length > 0) {
  console.error("Migrations applied, but foreign_key_check found violations after migrating:", violations);
  process.exitCode = 1;
} else {
  console.log("Migrations applied successfully.");
}
