import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { commitImport, transformRow } from "./importBatch";
import { computeImportRowHash } from "./hash";
import type { ParsedRow } from "./parseCsv";

// `commitImport` calls `createSnapshot` against a real `data/money.db` path,
// which does not exist in the test environment — stubbed the same way
// `src/lib/simplefin/sync.test.ts` stubs it, so these tests can drive the
// `consistent`/`degradedReason` branch without touching disk.
const { createSnapshotMock, pruneSnapshotsMock } = vi.hoisted(() => ({
  createSnapshotMock: vi.fn(() => ({
    snapshotPath: "/tmp/money.db.pre-import-TEST",
    timestamp: "TEST",
    consistent: true,
    degradedReason: null as string | null,
  })),
  pruneSnapshotsMock: vi.fn(() => ({ prunedPaths: [], failedPaths: [] })),
}));

vi.mock("./snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshot")>()),
  createSnapshot: createSnapshotMock,
  pruneSnapshots: pruneSnapshotsMock,
}));

const STAR_ONE_CSV = [
  "Transaction Number,Date,Description,Memo,Amount Debit,Amount Credit,Balance,Check Number,Fees",
  '12345,04/16/2026,WITHDRAWAL,"TST*THE BRASS TAP - Modesto CA Card #:8568",37.13,,1000.00,,',
].join("\n");

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    rowIndex: 0,
    bankTransactionNumber: "12345",
    date: "2026-04-16",
    rawDescription: "WITHDRAWAL",
    rawMemo: "TST*THE BRASS TAP - Modesto CA Card #:8568",
    amountCents: -3713,
    balanceCents: 10000,
    checkNumber: null,
    fees: null,
    isPending: false,
    ...overrides,
  };
}

describe("transformRow", () => {
  it("computes importRowHash deterministically from the 5 inputs", () => {
    const r = row();
    const result = transformRow(r);
    const expected = computeImportRowHash({
      date: r.date,
      amountCents: r.amountCents,
      rawDescription: r.rawDescription,
      rawMemo: r.rawMemo,
      rowIndex: r.rowIndex,
    });
    expect(result.importRowHash).toBe(expected);
  });

  it("normalizes merchant and extracts card last-four", () => {
    const result = transformRow(row());
    expect(result.normalizedMerchant).toContain("BRASS TAP");
    expect(result.normalizedMerchant).toBe(result.normalizedMerchant.toUpperCase());
    expect(result.cardLastFour).toBe("8568");
  });

  it("returns null cardLastFour when no Card # is present", () => {
    const result = transformRow(row({ rawMemo: "NETFLIX.COM" }));
    expect(result.cardLastFour).toBeNull();
  });

  it("preserves sign, date, and pending flag", () => {
    const deposit = transformRow(
      row({
        rawDescription: "DEPOSIT",
        amountCents: 50000,
        isPending: true,
        bankTransactionNumber: "6098",
      }),
    );
    expect(deposit.amountCents).toBe(50000);
    expect(deposit.rawDescription).toBe("DEPOSIT");
    expect(deposit.isPending).toBe(true);
    expect(deposit.bankTransactionNumber).toBe("6098");
  });

  it("produces distinct hashes for rows that differ only by rowIndex", () => {
    const a = transformRow(row({ rowIndex: 0 }));
    const b = transformRow(row({ rowIndex: 1 }));
    expect(a.importRowHash).not.toBe(b.importRowHash);
  });
});

describe("commitImport", () => {
  let handle: TestDbHandle;
  let accountId: number;

  beforeEach(() => {
    handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    accountId = account.id;
  });

  afterEach(() => {
    handle.close();
  });

  it("commits and reports no warnings when the snapshot is consistent", () => {
    const result = commitImport(
      { accountId, filename: "test.csv", csvText: STAR_ONE_CSV },
      handle.db,
    );
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.warnings).toEqual([]);
    expect(result.snapshot.snapshotPath).toBe("/tmp/money.db.pre-import-TEST");

    const [batch] = handle.db.select().from(schema.importBatches).all();
    expect(batch.snapshotWarning).toBeNull();
    // `label` is the renamed, now-nullable former `filename` column — a CSV
    // batch always carries the real uploaded filename as its label.
    expect(batch.label).toBe("test.csv");
  });

  // TODOS.md P0 / plan T6a — importBatch.ts silently recorded a degraded
  // snapshot as if it were a good rollback target. It must still commit
  // (sync.ts's warn-and-proceed policy, not a new abort behavior) but the
  // caller must be told — durably, on the batch row, not just for the one
  // redirect right after commit (adversarial review: a URL-only warning is
  // forgeable and disappears on a later visit to the success page).
  it("still commits but surfaces a warning when the snapshot degrades to a plain copy", () => {
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: false,
      degradedReason: "database disk image is malformed",
    });

    const result = commitImport(
      { accountId, filename: "test.csv", csvText: STAR_ONE_CSV },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.insertedCount).toBe(1);
    expect(result.snapshot.snapshotPath).toBe("/tmp/money.db.pre-import-TEST");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("database disk image is malformed");

    const [batch] = handle.db.select().from(schema.importBatches).all();
    expect(batch.snapshotPath).toBe("/tmp/money.db.pre-import-TEST");
    expect(batch.snapshotWarning).toContain("database disk image is malformed");
  });

  it("omits the parenthetical when the snapshot degrades with no reason given", () => {
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: false,
      degradedReason: null,
    });

    const result = commitImport(
      { accountId, filename: "test.csv", csvText: STAR_ONE_CSV },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toMatch(/\(null\)|\(\)/);
  });

  // Docker PR review finding: commitImport used to cache DB_PATH/SNAPSHOT_DIR
  // in module-level consts computed once at import time, unlike every other
  // paths.ts consumer (see src/lib/paths.test.ts — "reads process.env at call
  // time, no module-level caching"). A snapshot that silently landed back on
  // DATA_DIR instead of the SNAPSHOT_DIR bind mount would defeat the entire
  // point of splitting them (CLAUDE.md's Docker section: snapshots must
  // survive `docker compose down -v`).
  it("passes the current SNAPSHOT_DIR (not DATA_DIR) to createSnapshot/pruneSnapshots", async () => {
    process.env.DATA_DIR = "/tmp/mm-test-data";
    process.env.SNAPSHOT_DIR = "/tmp/mm-test-backups";
    try {
      const { dbPath, snapshotDir } = await import("./paths");
      createSnapshotMock.mockClear();
      pruneSnapshotsMock.mockClear();

      commitImport(
        { accountId, filename: "test.csv", csvText: STAR_ONE_CSV },
        handle.db,
      );

      expect(createSnapshotMock).toHaveBeenCalledWith(dbPath(), snapshotDir());
      expect(pruneSnapshotsMock).toHaveBeenCalledWith(snapshotDir());
      expect(snapshotDir()).not.toBe(dbPath());
    } finally {
      delete process.env.DATA_DIR;
      delete process.env.SNAPSHOT_DIR;
    }
  });
});
