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
import { createSnapshot, listSnapshots, pruneSnapshots, PRE_MIGRATE_PREFIX } from "./snapshot";

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
      createSnapshot(dbPath, undefined, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    // createSnapshot no longer prunes: all 12 are still on disk until asked.
    expect(listSnapshots(dir).length).toBe(12);

    pruneSnapshots(dir, 10);
    expect(listSnapshots(dir).length).toBe(10);
  });

  it("returns the paths it pruned", () => {
    for (let i = 0; i < 11; i++) {
      createSnapshot(dbPath, undefined, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
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
      createSnapshot(dbPath, undefined, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    const before = listSnapshots(dir);

    // A sync that snapshots and then throws never reaches pruneSnapshots.
    createSnapshot(dbPath, undefined, new Date(Date.UTC(2026, 0, 1, 0, 0, 10)));

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

/**
 * V1 — regression guard for splitting SNAPSHOT_DIR from DATA_DIR (docs/plans/
 * dockerize-postgres.md, D3.3B). Callers must prune the directory snapshots
 * actually land in. Passing path.dirname(dbPath) instead — the pre-split
 * behavior — would prune an empty directory, report success, and silently
 * stop retention forever.
 */
describe("createSnapshot / pruneSnapshots — SNAPSHOT_DIR split from DATA_DIR", () => {
  let dataDir: string;
  let snapDir: string;
  let dbPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "mm-data-"));
    snapDir = mkdtempSync(path.join(tmpdir(), "mm-snapshots-"));
    dbPath = path.join(dataDir, "money.db");
    writeFileSync(dbPath, "seed-bytes");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(snapDir, { recursive: true, force: true });
  });

  it("creates the snapshot dir when it doesn't exist yet, rather than throwing", () => {
    const freshDir = path.join(snapDir, "not-created-yet");
    expect(existsSync(freshDir)).toBe(false);

    // dbPath here is fake bytes (not a real sqlite file), so this exercises
    // the copyFileSync fallback — which needs the target directory to exist
    // just as much as VACUUM INTO does. The regression this guards is the
    // uncaught ENOENT when neither write path found the dir already there.
    const result = createSnapshot(dbPath, freshDir);

    expect(existsSync(freshDir)).toBe(true);
    expect(existsSync(result.snapshotPath)).toBe(true);
    expect(listSnapshots(freshDir).length).toBe(1);
  });

  it("writes snapshots to the given dir, not the db's own dir, and still prunes to 10 after 12", () => {
    for (let i = 0; i < 12; i++) {
      createSnapshot(dbPath, snapDir, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }

    expect(listSnapshots(dataDir).length).toBe(0);
    expect(listSnapshots(snapDir).length).toBe(12);

    pruneSnapshots(snapDir, 10);

    expect(listSnapshots(snapDir).length).toBe(10);
    expect(listSnapshots(dataDir).length).toBe(0);
  });
});

/**
 * Red Team finding: docker/entrypoint.mjs snapshots on every container boot
 * (crash loop, `restart: unless-stopped`), which is a much higher frequency
 * than a human running an import or sync. If boot snapshots shared the
 * pre-import prefix/pool, restart noise could silently evict a real
 * pre-import or pre-sync rollback snapshot the next time THAT retention-of-10
 * prune ran. PRE_MIGRATE_PREFIX keeps the two pools from ever counting
 * against each other.
 */
describe("createSnapshot / pruneSnapshots — prefix isolates the pre-migrate pool from pre-import", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-snapshot-prefix-"));
    dbPath = path.join(dir, "money.db");
    writeFileSync(dbPath, "seed-bytes");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("createSnapshot with PRE_MIGRATE_PREFIX writes a differently-named file", () => {
    const { snapshotPath } = createSnapshot(dbPath, dir, new Date(), PRE_MIGRATE_PREFIX);
    expect(path.basename(snapshotPath).startsWith(PRE_MIGRATE_PREFIX)).toBe(true);
  });

  it("listSnapshots/pruneSnapshots only see the prefix they're asked for", () => {
    for (let i = 0; i < 3; i++) {
      createSnapshot(dbPath, dir, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    for (let i = 0; i < 3; i++) {
      createSnapshot(dbPath, dir, new Date(Date.UTC(2026, 0, 1, 0, 1, i)), PRE_MIGRATE_PREFIX);
    }

    expect(listSnapshots(dir).length).toBe(3); // default prefix only
    expect(listSnapshots(dir, PRE_MIGRATE_PREFIX).length).toBe(3);
  });

  it("11 boot restarts cannot evict a real pre-import snapshot from the pre-import pool", () => {
    // One real CSV-import snapshot...
    createSnapshot(dbPath, dir, new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
    // ...then 11 container restarts, each snapshotting into the OTHER pool.
    for (let i = 0; i < 11; i++) {
      createSnapshot(dbPath, dir, new Date(Date.UTC(2026, 0, 1, 1, 0, i)), PRE_MIGRATE_PREFIX);
    }
    pruneSnapshots(dir, 10, PRE_MIGRATE_PREFIX);

    // The real import snapshot is untouched — pruning the boot pool never
    // looked at the pre-import pool at all.
    expect(listSnapshots(dir).length).toBe(1);
    expect(listSnapshots(dir, PRE_MIGRATE_PREFIX).length).toBe(10);
  });
});
