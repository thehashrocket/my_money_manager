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
 * change state mid-transaction.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const DB_PATH = path.join(process.cwd(), "data", "money.db");
const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = OFF");

try {
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  console.log("Migrations applied successfully.");
} finally {
  sqlite.pragma("foreign_keys = ON");
  const violations = sqlite.pragma("foreign_key_check");
  if (violations.length > 0) {
    console.error("foreign_key_check found violations after migrating:", violations);
    process.exitCode = 1;
  }
  sqlite.close();
}
