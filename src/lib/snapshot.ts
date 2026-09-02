import {
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const SNAPSHOT_RETENTION = 10;
const SNAPSHOT_PREFIX = "money.db.pre-import-";

export type SnapshotResult = {
  snapshotPath: string;
  timestamp: string;
  prunedPaths: string[];
};

function formatTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `_${pad(d.getUTCMilliseconds(), 3)}Z`
  );
}

export function listSnapshots(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  const entries = readdirSync(dataDir)
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX))
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
  now: Date = new Date(),
  retention: number = SNAPSHOT_RETENTION,
): SnapshotResult {
  if (!existsSync(dbPath)) {
    throw new Error(`database file does not exist: ${dbPath}`);
  }
  const dataDir = path.dirname(dbPath);
  const ts = formatTimestamp(now);
  const snapshotPath = path.join(dataDir, `${SNAPSHOT_PREFIX}${ts}`);

  // The database runs in WAL mode (see src/db/index.ts), so committed
  // transactions can still live in money.db-wal and would be absent from a bare
  // file copy — and restoring an older main file beside a newer -wal leaves
  // SQLite applying a mismatched log. Fold the WAL back in first so the
  // snapshot is a complete, standalone database. Best-effort: a checkpoint can
  // legitimately fail if another connection holds a read lock, and a snapshot
  // that is merely stale beats no snapshot at all.
  try {
    const src = new Database(dbPath);
    src.pragma("wal_checkpoint(TRUNCATE)");
    src.close();
  } catch {
    // fall through to the plain copy
  }

  copyFileSync(dbPath, snapshotPath);

  const all = listSnapshots(dataDir);
  const prunedPaths: string[] = [];
  for (const p of all.slice(retention)) {
    unlinkSync(p);
    prunedPaths.push(p);
  }
  return { snapshotPath, timestamp: ts, prunedPaths };
}
