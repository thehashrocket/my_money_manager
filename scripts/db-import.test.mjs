import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  assertNoWalSidecar,
  assertValidImportArgs,
  assertRestorableSnapshot,
} from "./db-import.mjs";

function makeRealDb(filePath, { withAccountsTable = true } = {}) {
  const db = new Database(filePath);
  if (withAccountsTable) {
    db.exec(
      "CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, starting_balance_cents INTEGER NOT NULL)",
    );
  } else {
    db.exec("CREATE TABLE something_else (id INTEGER PRIMARY KEY)");
  }
  db.close();
}

describe("assertNoWalSidecar", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a bare money.db that has a -wal sidecar", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-import-guard-"));
    const dbFile = path.join(dir, "money.db");
    writeFileSync(dbFile, "main-bytes");
    writeFileSync(`${dbFile}-wal`, "wal-bytes");

    const result = assertNoWalSidecar(dbFile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("-wal");
  });

  it("accepts a VACUUM INTO snapshot file with no sidecars", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-import-guard-"));
    const snapshotFile = path.join(dir, "money.db.pre-import-20260101T000000_000Z");
    writeFileSync(snapshotFile, "snapshot-bytes");

    expect(assertNoWalSidecar(snapshotFile)).toEqual({ ok: true });
  });
});

describe("assertRestorableSnapshot", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a 0-byte / non-database file — SQLite would silently treat it as an empty valid db", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-restorable-"));
    const emptyFile = path.join(dir, "money.db.pre-import-empty");
    writeFileSync(emptyFile, "");

    const result = assertRestorableSnapshot(emptyFile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("accounts");
  });

  it("refuses a real SQLite file missing the accounts table", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-restorable-"));
    const dbFile = path.join(dir, "money.db.pre-import-wrong-schema");
    makeRealDb(dbFile, { withAccountsTable: false });

    const result = assertRestorableSnapshot(dbFile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not look like a my_money_manager database");
  });

  it("refuses a file that isn't a SQLite database at all", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-restorable-"));
    const notADb = path.join(dir, "money.db.pre-import-garbage");
    writeFileSync(notADb, "this is not a sqlite file, just plain text bytes");

    const result = assertRestorableSnapshot(notADb);
    expect(result.ok).toBe(false);
  });

  it("accepts a real snapshot with an accounts table", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-restorable-"));
    const dbFile = path.join(dir, "money.db.pre-import-real");
    makeRealDb(dbFile, { withAccountsTable: true });

    expect(assertRestorableSnapshot(dbFile)).toEqual({ ok: true });
  });
});

describe("assertValidImportArgs", () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("refuses with no argument", () => {
    const result = assertValidImportArgs(undefined);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Usage:");
  });

  it("refuses a path that doesn't exist", () => {
    const result = assertValidImportArgs("/tmp/mm-does-not-exist-12345/money.db");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("No such file");
  });

  it("refuses an existing file that has a -wal sidecar", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-import-args-"));
    const dbFile = path.join(dir, "money.db");
    writeFileSync(dbFile, "main-bytes");
    writeFileSync(`${dbFile}-wal`, "wal-bytes");

    const result = assertValidImportArgs(dbFile);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("-wal");
  });

  it("refuses an existing file with no -wal but that isn't a real database", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-import-args-"));
    const snapshotFile = path.join(dir, "money.db.pre-import-20260101T000000_000Z");
    writeFileSync(snapshotFile, "snapshot-bytes");

    const result = assertValidImportArgs(snapshotFile);
    expect(result.ok).toBe(false);
  });

  it("accepts a real snapshot file with no sidecars and an accounts table", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-import-args-"));
    const snapshotFile = path.join(dir, "money.db.pre-import-20260101T000000_000Z");
    makeRealDb(snapshotFile, { withAccountsTable: true });

    expect(assertValidImportArgs(snapshotFile)).toEqual({ ok: true });
  });
});
