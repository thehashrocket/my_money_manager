import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  accountBalances,
  tableCounts,
  assertVolumeEmpty,
  assertConsistentSnapshot,
  verifySeed,
} from "./seed-volume.mjs";

describe("seed-volume helpers", () => {
  let dir;
  let dbFile;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mm-seed-helpers-"));
    dbFile = path.join(dir, "money.db");
    const sqlite = new Database(dbFile);
    sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(sqlite), {
      migrationsFolder: path.join(process.cwd(), "drizzle"),
    });
    sqlite
      .prepare(
        "INSERT INTO accounts (name, type, starting_balance_cents, starting_balance_date) VALUES (?, ?, ?, ?)",
      )
      .run("Checking", "checking", 10_000, "2026-01-01");
    sqlite
      .prepare("INSERT INTO import_batches (source, transaction_count) VALUES (?, ?)")
      .run("csv", 1);
    sqlite
      .prepare(
        "INSERT INTO transactions (account_id, date, raw_description, raw_memo, normalized_merchant, amount_cents, import_source, import_batch_id, import_row_hash) VALUES (1, '2026-02-01', 'WITHDRAWAL', 'Coffee', 'coffee', -500, 'csv', 1, 'h1')",
      )
      .run();
    sqlite.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("computes per-account balance as starting balance + sum of later transactions (CLAUDE.md rule 1)", () => {
    const balances = accountBalances(dbFile);
    expect(balances).toEqual({ 1: 10_000 - 500 });
  });

  it("counts rows per table", () => {
    const counts = tableCounts(dbFile, ["accounts", "transactions", "import_batches"]);
    expect(counts).toEqual({ accounts: 1, transactions: 1, import_batches: 1 });
  });

  it("balance ignores transactions dated on or before the starting balance date", () => {
    const sqlite = new Database(dbFile);
    sqlite
      .prepare(
        "INSERT INTO transactions (account_id, date, raw_description, raw_memo, normalized_merchant, amount_cents, import_source, import_batch_id, import_row_hash) VALUES (1, '2026-01-01', 'WITHDRAWAL', 'Old', 'old', -999999, 'csv', 1, 'h2')",
      )
      .run();
    sqlite.close();

    const balances = accountBalances(dbFile);
    expect(balances[1]).toBe(10_000 - 500);
  });
});

describe("assertVolumeEmpty", () => {
  it("refuses when the volume already has a money.db", () => {
    const result = assertVolumeEmpty(true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("already has a money.db");
  });

  it("passes when the volume is empty", () => {
    expect(assertVolumeEmpty(false)).toEqual({ ok: true });
  });
});

describe("assertConsistentSnapshot", () => {
  it("refuses a degraded (plain-copy) snapshot", () => {
    const result = assertConsistentSnapshot({
      consistent: false,
      degradedReason: "not a database file",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("degraded to a plain copy");
    expect(result.message).toContain("not a database file");
  });

  it("passes a consistent (VACUUM INTO) snapshot", () => {
    expect(assertConsistentSnapshot({ consistent: true, degradedReason: null })).toEqual({
      ok: true,
    });
  });
});

describe("verifySeed", () => {
  const base = {
    tables: ["accounts", "transactions"],
    sourceCounts: { accounts: 1, transactions: 3 },
    sourceBalances: { 1: 9_500 },
  };

  it("passes when counts and balances match exactly", () => {
    const result = verifySeed({
      ...base,
      volumeCounts: { accounts: 1, transactions: 3 },
      volumeBalances: { 1: 9_500 },
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails on a row count mismatch, naming the table", () => {
    const result = verifySeed({
      ...base,
      volumeCounts: { accounts: 1, transactions: 2 },
      volumeBalances: { 1: 9_500 },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('table "transactions"');
  });

  it("fails on a balance mismatch, naming the account", () => {
    const result = verifySeed({
      ...base,
      volumeCounts: { accounts: 1, transactions: 3 },
      volumeBalances: { 1: 9_000 },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("account 1");
  });
});
