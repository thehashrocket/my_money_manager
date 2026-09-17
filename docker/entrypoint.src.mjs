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
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
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
 * Whether `migrate()` would actually apply anything against this database —
 * mirrors drizzle's own comparison (SQLiteSyncDialect#migrate: a migration
 * runs iff its folderMillis exceeds the newest applied one) rather than a
 * cruder "row count differs from journal length" heuristic, so it can't drift
 * from what the migrator itself decides.
 *
 * Exists to gate the pre-migrate snapshot + prune below: those used to run on
 * every successful boot regardless of whether anything was pending, so
 * `restart: unless-stopped` spent the 10-slot retention pool on ordinary
 * restarts and could evict a real migration's rollback point within ~10 boots
 * (TODOS.md, "the container spends a snapshot retention slot on every
 * restart, not on every migration"). Self-contained and DB-path-injectable
 * like `runMigrations`, so it's testable against a temp file.
 */
export function hasPendingMigrations(dbPath, migrationsFolder) {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length === 0) return false;
  if (!existsSync(dbPath)) return true;

  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const table = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get();
    if (!table) return true;

    const row = sqlite.prepare('SELECT MAX(created_at) AS maxCreatedAt FROM "__drizzle_migrations"').get();
    if (row?.maxCreatedAt == null) return true;

    return migrations.some((m) => m.folderMillis > row.maxCreatedAt);
  } finally {
    sqlite.close();
  }
}

/**
 * Whether a pre-migrate snapshot is usable, in the same `{ok, message}` shape
 * as `checkTz`/`checkCwd` — pulled out of `main()` (pre-landing review,
 * testing specialist) because the one behavioral change this file makes to
 * the degraded-snapshot path — warn-and-continue became refuse — had no
 * direct test. `main()` isn't unit-testable (it calls `process.exit` and
 * imports `/app/server.js`), and forcing `createSnapshot` to report
 * `consistent: false` for real means reproducing the exact race rule 5
 * documents (a reader pinned during `VACUUM INTO`) rather than something a
 * test can synthesize — so the decision is tested directly, on a plain
 * object literal, instead.
 */
export function checkPreMigrateSnapshot(snapshot) {
  if (snapshot.consistent) return { ok: true };
  return {
    ok: false,
    // Red-team finding: the original message suggested `pnpm db:export`,
    // which runs `docker compose exec` against a RUNNING container — the one
    // thing that does not exist at the exact moment this message fires (the
    // container just refused to boot). `pnpm db:import` starts from a
    // stopped container by design, so it's the one remedy actually usable
    // here. And a degraded snapshot on THIS bind mount specifically
    // (SNAPSHOT_DIR=/app/backups) is the CLAUDE.md-documented EACCES hazard
    // — an unprivileged container user with no write access to a
    // root-owned bind mount — not only the reader-pinned VACUUM race the
    // original wording implied, so the message points there by name rather
    // than assuming which one it is. Named without repeating the exact
    // remedy command (adversarial review, Codex): CLAUDE.md is the one
    // place that command lives, so this message can't drift from it if that
    // guidance is ever refined.
    message:
      `Pre-migrate snapshot degraded (${snapshot.degradedReason}) — refusing to run a schema migration with no usable rollback point (${snapshot.snapshotPath}). ` +
      `If this looks like a permissions error on the backups bind mount, see CLAUDE.md's Docker section for the documented fix — this is the same EACCES hazard recorded there. ` +
      `Otherwise, stop whatever is holding a read on the database and retry, or restore a known-good snapshot with 'pnpm db:import <file>', which stops and restarts the container itself.`,
  };
}

/**
 * Moves a degraded pre-migrate snapshot file OUT of PRE_MIGRATE_PREFIX's
 * retention pool, without deleting it (rule 5: even a degraded copy "beats
 * no snapshot at all" and may still have manual recovery value).
 *
 * Adversarial review (Codex, cross-model-confirmed by the Claude subagent
 * independently): `createSnapshot`'s copyFileSync fallback WRITES this file
 * to disk before ever reporting `consistent: false` — so by the time
 * `checkPreMigrateSnapshot` refuses the boot, the file already exists under
 * `PRE_MIGRATE_PREFIX`, and `pruneSnapshots` was never reached to clean it
 * up (the refusal exits first). Under `restart: unless-stopped`, the exact
 * refusal this file introduces (a hard fail on a degraded snapshot) now
 * RETRIES the same failure on every restart, and each retry leaves ANOTHER
 * degraded file in the same shared 10-slot pool real historical snapshots
 * live in. `pruneSnapshots` has no way to tell a degraded file from a good
 * one — it only sees filenames and mtimes — so once more than 10 restarts
 * accumulate garbage, the eventual successful migration's prune call keeps
 * only the 10 MOST RECENT files, which by then are all crash-loop junk,
 * silently deleting every real rollback point. Renaming with a leading
 * `DEGRADED-` segment removes the file from `listSnapshots`' prefix match
 * (`name.startsWith(PRE_MIGRATE_PREFIX)`) entirely, so it can never compete
 * for a slot — while leaving it on disk for an operator to inspect or
 * delete by hand.
 *
 * Best-effort: a rename failure (e.g. a filesystem that can't rename across
 * the specific path) is logged, never thrown — this runs immediately before
 * `fail()` already exits the process, and losing the ability to quarantine
 * a file must not itself block reporting the real refusal reason.
 */
export function quarantineDegradedSnapshot(snapshotPath) {
  const quarantinePath = path.join(path.dirname(snapshotPath), `DEGRADED-${path.basename(snapshotPath)}`);
  try {
    renameSync(snapshotPath, quarantinePath);
    return quarantinePath;
  } catch (err) {
    console.error(
      `Could not quarantine degraded snapshot ${snapshotPath} out of the retained pool: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return snapshotPath;
  }
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

// Named once, passed to both hasPendingMigrations() and runMigrations() below
// — the two calls must always agree on which folder they're comparing
// against (pre-landing review, maintainability specialist: a bare literal
// duplicated across both call sites could silently desync the pending-check
// from the migration that actually runs).
const MIGRATIONS_FOLDER = "/app/drizzle";

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

  const dbExists = existsSync(DB_PATH);
  // Checked BEFORE opening the write connection that runMigrations() below
  // opens — this is the fact that decides whether tonight's restart is a
  // migration event at all, not just an ordinary reboot or crash-loop with
  // nothing new to apply. Wrapped in try/catch like the createSnapshot call
  // below it (pre-landing review, testing specialist): a truncated or locked
  // money.db — plausible in exactly the crash-loop scenario this function
  // exists to help with — makes better-sqlite3 throw, and that should fail
  // the boot with a readable message rather than an unhandled stack trace.
  // Read the migration files FIRST, in their own try/catch, unconditionally —
  // NOT nested inside `if (dbExists)` (adversarial review, cross-model: both
  // the Claude subagent and Codex independently traced this). `readMigrationFiles`
  // throws on a missing/incomplete `drizzle/` folder (an image build problem —
  // the folder never got bundled, or a migration .sql referenced by the
  // journal is missing), a failure class with nothing to do with the
  // DATABASE. Gating this check on `dbExists` meant a broken image discovered
  // on the FIRST-EVER boot (no db file yet — the most likely moment to catch
  // a bad build) skipped straight past it into `runMigrations`, whose
  // internal `migrate()` throws the identical error but reports it as
  // "Migration failed — refusing to boot on a half-applied schema" — the
  // exact misleading framing this diagnostic exists to prevent. This read is
  // cheap (small JSON + .sql files, no DB I/O) and redundant with
  // hasPendingMigrations' own internal call, which is the price of giving
  // the two failure classes their own accurate message on every boot path.
  try {
    readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  } catch (err) {
    fail(
      `Could not read migration files from ${MIGRATIONS_FOLDER} — this looks like an image build problem, not a database problem: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let migrationsPending = false;
  if (dbExists) {
    try {
      migrationsPending = hasPendingMigrations(DB_PATH, MIGRATIONS_FOLDER);
    } catch (err) {
      fail(
        `Could not check for pending migrations against ${DB_PATH} — refusing to boot on a database that can't be read: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (migrationsPending) {
    // PRE_MIGRATE_PREFIX, not the default pre-import- prefix: this runs on
    // every container start with a pending migration (crash loop,
    // `restart: unless-stopped`, a host reboot), which is a fundamentally
    // higher frequency than a human running an import or sync. Sharing the
    // pre-import pool would let restart noise silently evict a real rollback
    // snapshot from CSV import or /sync the next time THAT retention prune
    // runs.
    //
    // Gated on migrationsPending (not "does the db file exist") so an
    // ordinary restart with nothing to apply neither takes a snapshot nor
    // spends a slot pruning one — previously this ran on every successful
    // boot regardless, so `restart: unless-stopped` could evict a real
    // migration's only rollback snapshot within ~10 ordinary restarts.
    let snapshot;
    try {
      snapshot = createSnapshot(DB_PATH, snapshotDir(), new Date(), PRE_MIGRATE_PREFIX);
    } catch (err) {
      fail(
        `Pre-migrate snapshot failed — refusing to run a schema migration with no rollback point: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // A degraded snapshot used to be a warning-only, because it ran
    // regardless of whether a migration was actually about to happen and a
    // hard refusal would have blocked an ordinary restart for a rollback
    // point nothing needed. Now that this only runs when a migration IS
    // pending, a degraded snapshot means exactly what it says — no usable
    // rollback point for the schema change about to run — so it refuses
    // rather than proceeding on the strength of a `console.error`. See
    // checkPreMigrateSnapshot for why this decision is a separate, directly
    // testable function rather than inlined here.
    const check = checkPreMigrateSnapshot(snapshot);
    if (!check.ok) {
      // Quarantine BEFORE failing (adversarial review, cross-model): the
      // file createSnapshot's fallback already wrote is otherwise left in
      // the retained pool for every restart:unless-stopped retry to add
      // another one to, right up until the eventual successful migration's
      // prune call evicts real history to make room for the accumulated
      // junk. See quarantineDegradedSnapshot's own docstring.
      const quarantinedPath = quarantineDegradedSnapshot(snapshot.snapshotPath);
      // check.message was built from snapshot.snapshotPath, which the
      // quarantine above may have just moved — a successful rename means
      // that path no longer exists (Codex structured review: an operator
      // inspecting the preserved copy for manual recovery would get a
      // nonexistent filename from the startup logs otherwise).
      const note =
        quarantinedPath !== snapshot.snapshotPath ? ` The degraded copy was preserved at ${quarantinedPath}.` : "";
      fail(check.message + note);
    }
    console.log(`Pre-migrate snapshot: ${snapshot.snapshotPath}`);
  }

  const { migrationError, violations } = runMigrations(DB_PATH, MIGRATIONS_FOLDER);

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
  if (migrationsPending) {
    pruneSnapshots(snapshotDir(), SNAPSHOT_RETENTION, PRE_MIGRATE_PREFIX);
  }

  await import("/app/server.js");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
