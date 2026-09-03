import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const SNAPSHOT_RETENTION = 10;
const SNAPSHOT_PREFIX = "money.db.pre-import-";
/**
 * A separate pool from SNAPSHOT_PREFIX, matching scripts/migrate.mjs's
 * naming (CLAUDE.md rule 7) — used by docker/entrypoint.src.mjs, which
 * snapshots on every container boot. Sharing the pre-import prefix would
 * mean a restart-happy container (crash loop, `restart: unless-stopped`)
 * competes with real CSV-import/sync snapshots for the same retention-of-10
 * slots, silently evicting an actual rollback point a user might need.
 */
export const PRE_MIGRATE_PREFIX = "money.db.pre-migrate-";

export type SnapshotResult = {
  snapshotPath: string;
  timestamp: string;
  /**
   * True when the snapshot is a consistent standalone database. False means it
   * degraded to a bare file copy that may be missing WAL-resident commits —
   * still worth having, but the caller must say so rather than imply rule 5's
   * guarantee held.
   */
  consistent: boolean;
  /** Why the consistent path failed, when it did. */
  degradedReason: string | null;
};

function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `_${pad(d.getUTCMilliseconds(), 3)}Z`
  );
}

export function listSnapshots(dataDir: string, prefix: string = SNAPSHOT_PREFIX): string[] {
  if (!existsSync(dataDir)) return [];
  const entries = readdirSync(dataDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({
      name,
      full: path.join(dataDir, name),
      mtime: statSync(path.join(dataDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries.map((e) => e.full);
}

export function createSnapshot(
  dbPath: string,
  snapshotDir?: string,
  now: Date = new Date(),
  prefix: string = SNAPSHOT_PREFIX,
): SnapshotResult {
  if (!existsSync(dbPath)) {
    throw new Error(`database file does not exist: ${dbPath}`);
  }
  // Defaults to the db's own directory (today's behavior); callers that want
  // snapshots split onto a separate volume (see src/lib/paths.ts) pass one.
  const targetDir = snapshotDir ?? path.dirname(dbPath);
  // A caller-supplied SNAPSHOT_DIR that doesn't exist yet would otherwise
  // throw uncaught here (both VACUUM INTO and the copyFileSync fallback need
  // the directory to already exist) — a misconfiguration should degrade the
  // same way an unreadable source file does, not crash the caller.
  mkdirSync(targetDir, { recursive: true });
  const ts = formatTimestamp(now);
  const snapshotPath = path.join(targetDir, `${prefix}${ts}`);

  // The database runs in WAL mode (see src/db/index.ts), so committed
  // transactions can still live in money.db-wal and would be absent from a bare
  // file copy — and restoring an older main file beside a newer -wal leaves
  // SQLite applying a mismatched log.
  //
  // `VACUUM INTO` writes a consistent standalone copy through the connection,
  // so it sees WAL-resident commits by construction. It is used in preference to
  // checkpoint-then-copyFileSync because `PRAGMA wal_checkpoint` does NOT throw
  // when it cannot take the lock — it returns `{busy: 1, ...}`. The app's own
  // long-lived singleton connection is exactly such a reader, so the previous
  // try/catch could never detect the one failure it was written to handle.
  //
  // Measured with this repo's better-sqlite3, with a reader holding an open read
  // transaction: the checkpoint returned {busy: 1, log: 4, checkpointed: 3} and
  // the resulting copy did not merely lack recent rows — it failed to open at
  // all with SQLITE_CORRUPT, "database disk image is malformed". A partially
  // truncated WAL leaves the main file inconsistent on its own.
  let consistent = false;
  let degradedReason: string | null = null;
  let src: Database.Database | undefined;
  try {
    src = new Database(dbPath, { readonly: true });
    // Single-quoted SQL literal; escape any quote in the path rather than
    // interpolating blind. The path is ours, but this is still SQL text.
    src.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
    consistent = true;
  } catch (err) {
    degradedReason = err instanceof Error ? err.message : String(err);
  } finally {
    // close() in a finally: a throw from exec() previously leaked the handle
    // for the life of the dev server.
    src?.close();
  }

  if (!consistent) {
    // Not a SQLite database, or VACUUM could not run. A plain copy of whatever
    // is there beats no snapshot at all — but the caller is told it degraded.
    copyFileSync(dbPath, snapshotPath);
  }

  return { snapshotPath, timestamp: ts, consistent, degradedReason };
}

/**
 * Trims the snapshot directory to the most recent `retention` files.
 *
 * Deliberately NOT part of createSnapshot. Pruning there ran *before* the write
 * the snapshot protects, so a sync that then failed had already evicted the
 * oldest real snapshot to make room for a useless one — ten consecutive
 * failures left ten identical snapshots of an unchanged database and no history.
 * Callers prune only once their write has committed.
 *
 * A prune failure is reported, never thrown: losing the ability to delete an old
 * snapshot must not abort an import that has already succeeded.
 */
export function pruneSnapshots(
  dataDir: string,
  retention: number = SNAPSHOT_RETENTION,
  prefix: string = SNAPSHOT_PREFIX,
): { prunedPaths: string[]; failedPaths: string[] } {
  const prunedPaths: string[] = [];
  const failedPaths: string[] = [];
  for (const p of listSnapshots(dataDir, prefix).slice(retention)) {
    try {
      unlinkSync(p);
      prunedPaths.push(p);
    } catch {
      failedPaths.push(p);
    }
  }
  return { prunedPaths, failedPaths };
}
