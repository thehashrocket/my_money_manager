import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { createSnapshot, listSnapshots, pruneSnapshots } from "./snapshot";

describe("createSnapshot", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-snapshot-"));
    dbPath = path.join(dir, "money.db");
    writeFileSync(dbPath, "seed-bytes");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the db file with a pre-import- prefix", () => {
    const { snapshotPath } = createSnapshot(dbPath);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(path.basename(snapshotPath).startsWith("money.db.pre-import-")).toBe(true);
  });

  it("retains only the N most recent snapshots once pruned", () => {
    for (let i = 0; i < 12; i++) {
      // 1 second apart so timestamps and mtimes sort cleanly
      createSnapshot(dbPath, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    // createSnapshot no longer prunes: all 12 are still on disk until asked.
    expect(listSnapshots(dir).length).toBe(12);

    pruneSnapshots(dir, 10);
    expect(listSnapshots(dir).length).toBe(10);
  });

  it("returns the paths it pruned", () => {
    for (let i = 0; i < 11; i++) {
      createSnapshot(dbPath, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    const { prunedPaths, failedPaths } = pruneSnapshots(dir, 10);
    expect(prunedPaths.length).toBe(1);
    expect(failedPaths).toEqual([]);
    expect(readdirSync(dir).filter((n) => n.startsWith("money.db.pre-import-"))
      .length).toBe(10);
  });

  it("keeps a failed sync from evicting an older snapshot", () => {
    // The point of moving pruning out of createSnapshot: taking a snapshot for a
    // write that then fails must not cost you a real one from history.
    for (let i = 0; i < 10; i++) {
      createSnapshot(dbPath, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    const before = listSnapshots(dir);

    // A sync that snapshots and then throws never reaches pruneSnapshots.
    createSnapshot(dbPath, new Date(Date.UTC(2026, 0, 1, 0, 0, 10)));

    expect(before.every((p) => existsSync(p))).toBe(true);
  });

  it("throws if the db file is missing", () => {
    expect(() => createSnapshot(path.join(dir, "nope.db"))).toThrow();
  });
});

/**
 * The bug this covers: `PRAGMA wal_checkpoint` does NOT throw when it cannot
 * take the lock — it returns `{busy: 1, ...}`. The old code discarded that
 * result inside a try/catch, so with a second connection open (which is the
 * normal state: src/db/index.ts holds a long-lived singleton) the checkpoint
 * silently did nothing and copyFileSync copied the main file without the WAL.
 * The snapshot then quietly lacked the most recent commits — the exact
 * guarantee CLAUDE.md rule 5 exists to provide.
 */
describe("createSnapshot — WAL consistency", () => {
  let wdir: string;
  let wdbPath: string;
  let live: DatabaseType;

  beforeEach(() => {
    wdir = mkdtempSync(path.join(tmpdir(), "mm-snapshot-wal-"));
    wdbPath = path.join(wdir, "money.db");
    live = new Database(wdbPath);
    live.pragma("journal_mode = WAL");
    live.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)");
    live.prepare("INSERT INTO t (note) VALUES (?)").run("committed-to-wal");
  });

  afterEach(() => {
    live.close();
    rmSync(wdir, { recursive: true, force: true });
  });

  it("captures WAL-resident commits even when a checkpoint would report busy", () => {
    // A reader holding an OPEN read transaction pins an old snapshot, which is
    // what makes wal_checkpoint(TRUNCATE) return {busy: 1} and only partially
    // checkpoint. Verified against this repo's better-sqlite3: under exactly
    // these conditions the old checkpoint-then-copyFileSync approach produced a
    // snapshot that failed to open at all with SQLITE_CORRUPT ("database disk
    // image is malformed") — not merely one missing recent rows.
    const reader = new Database(wdbPath, { readonly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM t").all();

    // Commits while the reader is pinned; these live only in the WAL.
    live.prepare("INSERT INTO t (note) VALUES (?)").run("committed-while-pinned");

    const result = createSnapshot(wdbPath);
    expect(result.consistent).toBe(true);
    expect(result.degradedReason).toBeNull();

    const restored = new Database(result.snapshotPath, { readonly: true });
    const rows = restored.prepare("SELECT note FROM t").all() as {
      note: string;
    }[];
    restored.close();
    reader.exec("COMMIT");
    reader.close();

    expect(rows.map((r) => r.note)).toEqual([
      "committed-to-wal",
      "committed-while-pinned",
    ]);
  });

  it("still produces a snapshot, flagged degraded, when the file is not a database", () => {
    const plainPath = path.join(wdir, "not-a.db");
    writeFileSync(plainPath, "seed-bytes");

    const result = createSnapshot(plainPath);

    expect(existsSync(result.snapshotPath)).toBe(true);
    expect(result.consistent).toBe(false);
    expect(result.degradedReason).toBeTruthy();
    expect(readFileSync(result.snapshotPath, "utf8")).toBe("seed-bytes");
  });
});
