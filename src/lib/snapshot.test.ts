import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createSnapshot, listSnapshots } from "./snapshot";

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

  it("retains only the N most recent snapshots", () => {
    for (let i = 0; i < 12; i++) {
      // 1 second apart so timestamps and mtimes sort cleanly
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i));
      createSnapshot(dbPath, ts, 10);
    }
    const remaining = listSnapshots(dir);
    expect(remaining.length).toBe(10);
  });

  it("returns the paths it pruned on the overflow call", () => {
    for (let i = 0; i < 10; i++) {
      createSnapshot(dbPath, new Date(Date.UTC(2026, 0, 1, 0, 0, i)), 10);
    }
    const overflow = createSnapshot(
      dbPath,
      new Date(Date.UTC(2026, 0, 1, 0, 0, 10)),
      10,
    );
    expect(overflow.prunedPaths.length).toBe(1);
    expect(readdirSync(dir).filter((n) => n.startsWith("money.db.pre-import-"))
      .length).toBe(10);
  });

  it("throws if the db file is missing", () => {
    expect(() => createSnapshot(path.join(dir, "nope.db"))).toThrow();
  });
});
