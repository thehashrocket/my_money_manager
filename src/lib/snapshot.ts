import {
  copyFileSync,
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";

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
  copyFileSync(dbPath, snapshotPath);

  const all = listSnapshots(dataDir);
  const prunedPaths: string[] = [];
  for (const p of all.slice(retention)) {
    unlinkSync(p);
    prunedPaths.push(p);
  }
  return { snapshotPath, timestamp: ts, prunedPaths };
}
