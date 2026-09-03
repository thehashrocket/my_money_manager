/**
 * Container entrypoint: guard, migrate, then boot the Next standalone server.
 *
 * Bundled (not run as-is) by scripts/build-docker-artifacts.mjs into
 * docker/entrypoint.mjs during the Docker builder stage. It has to be
 * bundled rather than imported directly at runtime: this script pulls in
 * drizzle-orm (for the migrator) and this repo's own src/lib modules, and
 * `next build`'s standalone output does NOT copy drizzle-orm into
 * node_modules at all — it gets compiled straight into Next's private
 * server bundle, unreachable from a plain script run by `node`. Only
 * `better-sqlite3` is guaranteed present (it's in Next's
 * `serverExternalPackages` list, so the tracer copies the resolved package
 * tree, native binary included) — everything else this file needs must be
 * inlined, which is what bundling does. Kept as `external` in the esbuild
 * config for exactly that reason.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dataDir, dbPath, snapshotDir } from "../src/lib/paths.ts";
import {
  createSnapshot,
  pruneSnapshots,
  PRE_MIGRATE_PREFIX,
  SNAPSHOT_RETENTION,
} from "../src/lib/snapshot.ts";

export function checkTz(env = process.env) {
  if (!env.TZ) {
    return {
      ok: false,
      message:
        "TZ is required — the app derives the current budget month from local time. " +
        "Set TZ in compose.yaml (e.g. TZ=America/Los_Angeles), or TZ=UTC if that is genuinely what you want.",
    };
  }
  // A non-empty but invalid IANA zone name (a typo like America/Los_Angelss)
  // doesn't throw anywhere — Node silently falls back to UTC-like behavior,
  // reintroducing the exact bug this file exists to prevent, with no signal
  // that anything is wrong. Intl.DateTimeFormat is the cheap way to ask "is
  // this actually a zone" without hand-maintaining a list of valid names.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: env.TZ });
  } catch {
    return {
      ok: false,
      message: `TZ="${env.TZ}" is not a recognized IANA timezone — Node would silently treat it as UTC, computing the wrong budget month for part of every day. Check for a typo (e.g. "America/Los_Angeles").`,
    };
  }
  return { ok: true };
}

export function checkCwd(cwd = process.cwd()) {
  if (cwd === "/app") return { ok: true };
  return {
    ok: false,
    message:
      `expected to run from /app (see Dockerfile WORKDIR), got ${cwd} instead — ` +
      "the ledger, snapshots, and pending-import stash (src/lib/paths.ts) would resolve outside the mounted volume.",
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * Pragmas-then-migrate-then-check, self-contained and DB-path-injectable so
 * it's testable against a temp file without needing to actually be at /app.
 * Returns rather than exits, so a caller decides what "failure" means.
 */
export function runMigrations(dbPath, migrationsFolder) {
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  // FK OFF for the migration itself — deliberately NOT the app's own ON
  // setting (src/db/index.ts:17-18). CLAUDE.md rule 7: a table-rebuild
  // migration (SQLite's only way to relax a NOT NULL constraint) DROPs a
  // table other tables reference via onDelete:'restrict' — with FK ON that
  // fails the moment real rows reference it, even though the rebuilt table
  // ends up satisfying every reference by commit. This mirrors
  // scripts/migrate.mjs exactly, not the app's runtime connection pragmas.
  sqlite.pragma("foreign_keys = OFF");

  let migrationError = null;
  try {
    migrate(drizzle(sqlite), { migrationsFolder });
  } catch (err) {
    migrationError = err;
  }

  // Runs regardless of migrationError — a partially-applied rebuild is
  // exactly when a dangling reference is most likely, and this pragma works
  // regardless of the foreign_keys setting above.
  const violations = sqlite.pragma("foreign_key_check");
  sqlite.close();

  return { migrationError, violations };
}

export async function main() {
  const tz = checkTz();
  if (!tz.ok) fail(tz.message);

  const cwd = checkCwd();
  if (!cwd.ok) fail(cwd.message);

  const DATA_DIR = dataDir();
  const DB_PATH = dbPath();

  if (!existsSync(DATA_DIR)) {
    fail(`data directory does not exist: ${DATA_DIR} — is the volume mounted?`);
  }

  const tookPreMigrateSnapshot = existsSync(DB_PATH);
  if (tookPreMigrateSnapshot) {
    // PRE_MIGRATE_PREFIX, not the default pre-import- prefix: this runs on
    // every container start (crash loop, `restart: unless-stopped`, a host
    // reboot), which is a fundamentally higher frequency than a human
    // running an import or sync. Sharing the pre-import pool would let
    // restart noise silently evict a real rollback snapshot from CSV import
    // or /sync the next time THAT retention prune runs.
    let snapshot;
    try {
      snapshot = createSnapshot(DB_PATH, snapshotDir(), new Date(), PRE_MIGRATE_PREFIX);
    } catch (err) {
      fail(
        `Pre-migrate snapshot failed — refusing to run a schema migration with no rollback point: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!snapshot.consistent) {
      console.error(
        `WARNING: pre-migrate snapshot degraded (${snapshot.degradedReason}) — proceeding with the migration anyway, but ${snapshot.snapshotPath} may not be a usable rollback point.`,
      );
    } else {
      console.log(`Pre-migrate snapshot: ${snapshot.snapshotPath}`);
    }
  }

  const { migrationError, violations } = runMigrations(DB_PATH, "/app/drizzle");

  if (migrationError) {
    console.error("Migration failed — refusing to boot on a half-applied schema.");
    console.error(migrationError);
    if (violations.length > 0) {
      console.error("Additionally, foreign_key_check found violations:", violations);
    }
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("Migrations applied, but foreign_key_check found violations:", violations);
    process.exit(1);
  }

  console.log("Migrations applied successfully.");

  // Pruned only now that the migration above has succeeded (rule 5: pruning
  // before the write it protects can evict the one snapshot with real
  // rollback value to make room for one describing the same unchanged
  // database). Unlike scripts/migrate.mjs (a rare, manual, developer-invoked
  // command where unbounded accumulation is someone's problem to notice),
  // this runs unattended and can fire far more often.
  if (tookPreMigrateSnapshot) {
    pruneSnapshots(snapshotDir(), SNAPSHOT_RETENTION, PRE_MIGRATE_PREFIX);
  }

  await import("/app/server.js");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
