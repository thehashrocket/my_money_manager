import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import type { SimpleFinResponse, SimpleFinTransaction } from "./types";
import {
  syncSimpleFin,
  linkTransferPairManually,
  unlinkTransferPair,
  findLinkedTransferPairs,
} from "./sync";
import { setAccountLink } from "./link";
import { mapTransaction } from "./mapTransaction";

/**
 * Exercises the dedup and manual-pairing logic against a real :memory: schema.
 *
 * The credential reader, the HTTP client and the pre-write snapshot are the
 * three things `syncSimpleFin` reaches outside the database for, so all three
 * are stubbed: these tests need no network, no SIMPLEFIN_ACCESS_URL and no
 * data/money.db on disk.
 */
const { fetchAccountsMock, createSnapshotMock, pruneSnapshotsMock } = vi.hoisted(() => ({
  fetchAccountsMock: vi.fn(),
  createSnapshotMock: vi.fn(() => ({
    snapshotPath: "/tmp/money.db.pre-import-TEST",
    timestamp: "TEST",
    prunedPaths: [] as string[],
    consistent: true,
    degradedReason: null as string | null,
  })),
  pruneSnapshotsMock: vi.fn(() => ({ prunedPaths: [], failedPaths: [] })),
}));

vi.mock("./accessUrl", async (importOriginal) => {
  // Secret comes from importOriginal, not a top-level import: vi.mock factories
  // are hoisted above the import block, so a module-scope binding would not be
  // initialised yet when this runs.
  const actual = await importOriginal<typeof import("./accessUrl")>();
  return {
    ...actual,
    readAccessUrl: () => ({
      accountsEndpoint: "https://bridge.test/simplefin/accounts",
      authHeader: new actual.Secret("Basic dGVzdDp0ZXN0"),
      host: "bridge.test",
    }),
  };
});

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  fetchAccounts: fetchAccountsMock,
}));

vi.mock("../snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../snapshot")>()),
  createSnapshot: createSnapshotMock,
  pruneSnapshots: pruneSnapshotsMock,
}));


const NOW = new Date("2026-09-02T17:00:00Z");
/** 2026-09-01T12:00:00Z — Star One's noon-UTC posting convention. */
const SEP_1_NOON = 1788264000;
const COFFEE_MEMO = "STARBUCKS STORE 1234 MANTECA CA";

let handle: TestDbHandle;
let seq = 0;

beforeEach(() => {
  handle = createTestDb();
  fetchAccountsMock.mockReset();
  createSnapshotMock.mockClear();
});

afterEach(() => {
  handle.close();
});

function seedAccount(opts: { simplefinAccountId?: string | null; name?: string } = {}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: opts.name ?? `Checking-${seq}`,
      type: "checking",
      startingBalanceCents: 0,
      startingBalanceDate: "2026-01-01",
      simplefinAccountId: opts.simplefinAccountId ?? null,
    })
    .returning()
    .all();
  return row;
}

function seedBatch(source: "csv" | "simplefin") {
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source, label: `${source}.seed` })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  amountCents: number;
  rawMemo: string;
  date?: string;
  source?: "csv" | "simplefin";
  externalId?: string | null;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-09-01",
      rawDescription: opts.amountCents >= 0 ? "DEPOSIT" : "WITHDRAWAL",
      rawMemo: opts.rawMemo,
      normalizedMerchant: opts.rawMemo,
      amountCents: opts.amountCents,
      importSource: opts.source ?? "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      externalId: opts.externalId ?? null,
    })
    .returning()
    .all();
  return row;
}

function feedTxn(id: string, amount: string, memo = COFFEE_MEMO): SimpleFinTransaction {
  return {
    id,
    posted: SEP_1_NOON,
    amount,
    description: memo,
    memo,
    payee: "Starbucks",
    transacted_at: SEP_1_NOON,
    mcc: null,
  };
}

function respondWith(
  simplefinAccountId: string,
  transactions: SimpleFinTransaction[],
  balance = "0.00",
): void {
  fetchAccountsMock.mockResolvedValue({
    accounts: [
      {
        id: simplefinAccountId,
        name: "REGULAR SAVINGS",
        balance,
        "available-balance": balance,
        "balance-date": SEP_1_NOON,
        transactions,
      },
    ],
  } satisfies SimpleFinResponse);
}

describe("syncSimpleFin dedup", () => {
  it("dedups a re-sync on external_id and writes nothing at all", async () => {
    const account = seedAccount({ simplefinAccountId: "ACT-1" });
    const batch = seedBatch("simplefin");
    for (const id of ["TRN-a", "TRN-b"]) {
      seedTxn({
        accountId: account.id,
        batchId: batch.id,
        amountCents: -487,
        rawMemo: COFFEE_MEMO,
        source: "simplefin",
        externalId: id,
      });
    }

    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87"), feedTxn("TRN-b", "-4.87")]);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("up-to-date");
    if (outcome.status !== "up-to-date") throw new Error("unreachable");
    expect(outcome.accounts[0].duplicateByExternalId).toBe(2);
    expect(outcome.accounts[0].duplicateByContent).toBe(0);
    expect(outcome.accounts[0].insertedCount).toBe(0);
    // Nothing to write means no snapshot and no new batch row.
    expect(createSnapshotMock).not.toHaveBeenCalled();
    expect(handle.db.select().from(schema.importBatches).all()).toHaveLength(1);

    // Asked from a week before the newest row we already hold, not the floor.
    expect(fetchAccountsMock.mock.calls[0][1]).toMatchObject({
      accountIds: ["ACT-1"],
      startDate: Math.floor(new Date("2026-08-25T00:00:00Z").getTime() / 1000),
    });
  });

  it("dedups against CSV history on content as a multiset, not as a set", async () => {
    // Two identical coffees already imported from CSV. The feed re-sends those
    // two AND a third from the same day. Set-based dedup would drop all three;
    // counting means exactly two are absorbed and the third is new money.
    const account = seedAccount({ simplefinAccountId: "ACT-1" });
    const csv = seedBatch("csv");
    seedTxn({
      accountId: account.id,
      batchId: csv.id,
      amountCents: -487,
      rawMemo: COFFEE_MEMO,
    });
    seedTxn({
      accountId: account.id,
      batchId: csv.id,
      amountCents: -487,
      rawMemo: COFFEE_MEMO,
    });

    respondWith("ACT-1", [
      feedTxn("TRN-a", "-4.87"),
      feedTxn("TRN-b", "-4.87"),
      feedTxn("TRN-c", "-4.87"),
    ]);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");
    expect(outcome.insertedCount).toBe(1);
    expect(outcome.accounts[0].duplicateByContent).toBe(2);
    expect(outcome.accounts[0].duplicateByExternalId).toBe(0);
    // Snapshot taken BEFORE the write (CLAUDE.md rule 5).
    expect(createSnapshotMock).toHaveBeenCalledTimes(1);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(3);
    // The THIRD feed row is the survivor: the budget of two absorbed the first
    // two, in feed order.
    expect(rows.filter((r) => r.externalId !== null).map((r) => r.externalId)).toEqual([
      "TRN-c",
    ]);
    const written = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, outcome.batchId))
      .get();
    expect(written?.source).toBe("simplefin");
    expect(written?.transactionCount).toBe(1);
    expect(written?.snapshotPath).toBe("/tmp/money.db.pre-import-TEST");
  });

  it("keeps two genuinely identical same-day rows the feed sends", async () => {
    // No CSV history to absorb them, so both survive — this is the case the
    // multiset budget exists to protect.
    seedAccount({ simplefinAccountId: "ACT-1" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87"), feedTxn("TRN-b", "-4.87")], "-9.74");

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");
    expect(outcome.insertedCount).toBe(2);
    expect(outcome.accounts[0].duplicateByContent).toBe(0);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.map((r) => r.amountCents)).toEqual([-487, -487]);
    expect(rows.every((r) => r.importSource === "simplefin")).toBe(true);
    // Signs are passed through, so the ledger agrees with the bank's figure.
    expect(outcome.accounts[0].computedBalanceCents).toBe(-974);
    expect(outcome.accounts[0].reportedBalanceCents).toBe(-974);
    expect(outcome.accounts[0].driftCents).toBe(0);
  });

  it("skips unlinked accounts entirely rather than guessing a mapping", async () => {
    seedAccount({ simplefinAccountId: null, name: "Mortgage" });

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome).toEqual({ status: "no-linked-accounts" });
    expect(fetchAccountsMock).not.toHaveBeenCalled();
    expect(createSnapshotMock).not.toHaveBeenCalled();
  });

  // Docker PR review finding: syncSimpleFin used to cache DB_PATH/SNAPSHOT_DIR
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
      const { dbPath, snapshotDir } = await import("../paths");
      pruneSnapshotsMock.mockClear();
      seedAccount({ simplefinAccountId: "ACT-1" });
      respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);

      await syncSimpleFin({ now: NOW }, handle.db);

      expect(createSnapshotMock).toHaveBeenCalledWith(dbPath(), snapshotDir());
      expect(pruneSnapshotsMock).toHaveBeenCalledWith(snapshotDir());
      expect(snapshotDir()).not.toBe(dbPath());
    } finally {
      delete process.env.DATA_DIR;
      delete process.env.SNAPSHOT_DIR;
    }
  });
});

describe("linkTransferPairManually", () => {
  it("rejects pairings that cannot be a transfer", () => {
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");

    const out = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -10000,
      rawMemo: "WITHDRAWAL-OVERDRAFT",
    });
    const inSameAccount = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 10000,
      rawMemo: "REFUND",
    });
    const sameSign = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: -10000,
      rawMemo: "ANOTHER CHARGE",
    });
    const wrongAmount = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: 9900,
      rawMemo: "CLOSE BUT NOT EQUAL",
    });

    expect(() => linkTransferPairManually(out.id, 9999, handle.db)).toThrow(
      /Both transactions must exist/,
    );
    expect(() =>
      linkTransferPairManually(out.id, inSameAccount.id, handle.db),
    ).toThrow(/two different accounts/);
    expect(() => linkTransferPairManually(out.id, sameSign.id, handle.db)).toThrow(
      /opposite signs/,
    );
    expect(() => linkTransferPairManually(out.id, wrongAmount.id, handle.db)).toThrow(
      /equal absolute amounts/,
    );

    // Every rejection left the ledger untouched.
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
  });

  it("links both rows to each other so neither counts as spending", () => {
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const out = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -10000,
      rawMemo: "WITHDRAWAL-OVERDRAFT",
    });
    const inbound = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: 10000,
      rawMemo: "POS 0901 1026 797230 SAVEMART #12 MA MANTECA",
    });

    linkTransferPairManually(inbound.id, out.id, handle.db);

    const byId = new Map(
      handle.db
        .select()
        .from(schema.transactions)
        .all()
        .map((r) => [r.id, r]),
    );
    expect(byId.get(inbound.id)?.transferPairId).toBe(out.id);
    expect(byId.get(out.id)?.transferPairId).toBe(inbound.id);
  });
});

/**
 * Regression cover for the whitespace half of cross-source dedup.
 *
 * Star One's CSV pads pending-row memos with leading spaces and `parseCsv`
 * keeps them verbatim (import_row_hash is derived from the exact bytes). The
 * feed sends the same row trimmed. Comparing raw memo strings therefore missed
 * exactly the population content dedup exists for, and inserted the row twice.
 */
describe("syncSimpleFin — cross-source dedup ignores memo whitespace", () => {
  it("does not re-import a CSV row whose memo was stored with padding", async () => {
    const account = seedAccount({ simplefinAccountId: "ACT-pad" });
    const csvBatch = seedBatch("csv");
    seedTxn({
      accountId: account.id,
      batchId: csvBatch.id,
      amountCents: -4870,
      // Exactly what parseCsv stores for a pending row.
      rawMemo: `  ${COFFEE_MEMO}`,
      date: "2026-09-01",
    });

    respondWith("ACT-pad", [feedTxn("ext-pad-1", "-48.70")]);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("up-to-date");
    if (outcome.status !== "up-to-date") throw new Error("unreachable");
    expect(outcome.accounts[0].duplicateByContent).toBe(1);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.length).toBe(1);
    expect(rows.reduce((n, r) => n + r.amountCents, 0)).toBe(-4870);
  });

  it("collapses internal whitespace too, but still keeps genuinely different rows", async () => {
    const account = seedAccount({ simplefinAccountId: "ACT-pad2" });
    const csvBatch = seedBatch("csv");
    seedTxn({
      accountId: account.id,
      batchId: csvBatch.id,
      amountCents: -4870,
      rawMemo: "COSTCO WHSE #1031  MANTECA  CA",
      date: "2026-09-01",
    });

    respondWith("ACT-pad2", [
      feedTxn("ext-same", "-48.70", "COSTCO WHSE #1031 MANTECA CA"),
      feedTxn("ext-other", "-48.70", "SAFEWAY 2231 MANTECA CA"),
    ]);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");
    expect(outcome.insertedCount).toBe(1);
    expect(outcome.accounts[0].duplicateByContent).toBe(1);
    expect(handle.db.select().from(schema.transactions).all().length).toBe(2);
  });
});

describe("unlinkTransferPair / findLinkedTransferPairs", () => {
  function seedLinkedPair() {
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const a = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: 20000,
      rawMemo: "DEPOSIT-OVERDRAFT",
      date: "2026-09-01",
    });
    const b = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -20000,
      rawMemo: "WITHDRAWAL-OVERDRAFT",
      date: "2026-09-01",
    });
    linkTransferPairManually(a.id, b.id, handle.db);
    return { a, b };
  }

  it("lists a linked pair once, positive leg first", () => {
    const { a, b } = seedLinkedPair();
    const pairs = findLinkedTransferPairs("2026-01-01", handle.db);
    expect(pairs.length).toBe(1);
    expect(pairs[0].a.id).toBe(a.id);
    expect(pairs[0].b.id).toBe(b.id);
  });

  it("clears BOTH sides, so neither row is left pointing at a stale partner", () => {
    const { a, b } = seedLinkedPair();

    unlinkTransferPair(a.id, handle.db);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
    expect(findLinkedTransferPairs("2026-01-01", handle.db)).toEqual([]);
    // Both rows survive — unlinking is not deleting.
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("unlinks from either leg", () => {
    const { b } = seedLinkedPair();
    unlinkTransferPair(b.id, handle.db);
    expect(
      handle.db
        .select()
        .from(schema.transactions)
        .all()
        .every((r) => r.transferPairId === null),
    ).toBe(true);
  });

  it("is idempotent on an already-unlinked row, so a double submit is harmless", () => {
    const { a } = seedLinkedPair();
    unlinkTransferPair(a.id, handle.db);
    expect(() => unlinkTransferPair(a.id, handle.db)).not.toThrow();
  });

  it("rejects an unknown transaction rather than silently doing nothing", () => {
    expect(() => unlinkTransferPair(9999, handle.db)).toThrow(/No such transaction/);
  });

  it("relinking after an unlink is allowed (the pair guard is not sticky)", () => {
    const { a, b } = seedLinkedPair();
    unlinkTransferPair(a.id, handle.db);
    expect(() => linkTransferPairManually(a.id, b.id, handle.db)).not.toThrow();
    expect(findLinkedTransferPairs("2026-01-01", handle.db).length).toBe(1);
  });
});

/**
 * The `existing` lookup used to be bounded by startIso while the partial unique
 * index on (account_id, external_id) is not bounded at all. A feed row whose
 * DERIVED date fell before the window escaped both dedup paths — reachable via
 * postedToIsoDate's documented `posted === 0 -> transacted_at` fallback.
 */
describe("syncSimpleFin — rows dated before the fetch window", () => {
  /** 2026-08-01T12:00:00Z: before startIso (2026-08-25), after the 45-day floor. */
  const AUG_1_NOON = 1785585600;

  function backdatedFeedTxn(id: string, amount: string, memo = COFFEE_MEMO) {
    // posted === 0 makes postedToIsoDate fall back to transacted_at.
    return { ...feedTxn(id, amount, memo), posted: 0, transacted_at: AUG_1_NOON };
  }

  it("dedups an already-synced row instead of aborting the batch on the unique index", async () => {
    const account = seedAccount({ simplefinAccountId: "ACT-old" });
    const prior = seedBatch("simplefin");
    // Anchors startIso at 2026-08-25.
    seedTxn({
      accountId: account.id,
      batchId: prior.id,
      amountCents: -100,
      rawMemo: "ANCHOR",
      date: "2026-09-01",
      source: "simplefin",
      externalId: "TRN-anchor",
    });
    seedTxn({
      accountId: account.id,
      batchId: prior.id,
      amountCents: -487,
      rawMemo: COFFEE_MEMO,
      date: "2026-08-01",
      source: "simplefin",
      externalId: "TRN-backdated",
    });

    respondWith("ACT-old", [backdatedFeedTxn("TRN-backdated", "-4.87")]);

    // Previously: SqliteError, UNIQUE constraint failed, whole batch rolled back.
    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("up-to-date");
    if (outcome.status !== "up-to-date") throw new Error("unreachable");
    expect(outcome.accounts[0].duplicateByExternalId).toBe(1);
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
  });

  it("content-dedups a backdated row against a CSV row older than the window", async () => {
    const account = seedAccount({ simplefinAccountId: "ACT-old2" });
    const batch = seedBatch("csv");
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      amountCents: -100,
      rawMemo: "ANCHOR",
      date: "2026-09-01",
    });
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      amountCents: -487,
      rawMemo: COFFEE_MEMO,
      date: "2026-08-01",
    });

    // A NEW external id, so only content dedup can catch it.
    respondWith("ACT-old2", [backdatedFeedTxn("TRN-fresh", "-4.87")]);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("up-to-date");
    if (outcome.status !== "up-to-date") throw new Error("unreachable");
    expect(outcome.accounts[0].duplicateByContent).toBe(1);
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
  });
});

describe("syncSimpleFin — snapshot consistency", () => {
  it("still commits but persists a warning when the pre-sync snapshot degrades", async () => {
    seedAccount({ simplefinAccountId: "ACT-1" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    createSnapshotMock.mockReturnValueOnce({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      prunedPaths: [],
      consistent: false,
      degradedReason: "database disk image is malformed",
    });

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");
    // The write still happens — a degraded snapshot changes the safety net,
    // not whether the sync proceeds (CLAUDE.md rule 5).
    expect(outcome.insertedCount).toBe(1);
    expect(outcome.warnings.join(" ")).toMatch(/fell back to a plain file copy/);

    const written = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, outcome.batchId))
      .get();
    expect(written?.snapshotWarning).toMatch(/database disk image is malformed/);
  });

  it("persists no warning when the pre-sync snapshot is consistent", async () => {
    seedAccount({ simplefinAccountId: "ACT-1" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");

    const written = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, outcome.batchId))
      .get();
    expect(written?.snapshotWarning).toBeNull();
  });

  it("writes a sync batch with no label, relying on deriveBatchLabel for display", async () => {
    // The old synthetic `simplefin ${timestamp}` filename string is gone;
    // display now derives from source + importedAt (src/lib/batchLabel.ts).
    // A regression here would mean the sync path silently reintroduces a
    // stored label, which findLastSyncBatch's null-coalescing would then
    // never exercise.
    seedAccount({ simplefinAccountId: "ACT-1" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");

    const written = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, outcome.batchId))
      .get();
    expect(written?.label).toBeNull();
  });
});

describe("syncSimpleFin — pending rows", () => {
  it("refuses to write a pending row and says so, rather than freezing a pre-auth amount", async () => {
    seedAccount({ simplefinAccountId: "ACT-pending" });
    respondWith("ACT-pending", [
      { ...feedTxn("TRN-pending", "-40.00"), pending: true },
      feedTxn("TRN-posted", "-12.34"),
    ]);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");
    expect(outcome.insertedCount).toBe(1);
    expect(outcome.accounts[0].skippedPending).toBe(1);
    expect(outcome.warnings.join(" ")).toMatch(/Skipped 1 pending transaction/);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("TRN-posted");
    // Nothing written is ever flagged pending.
    expect(rows.every((r) => r.isPending === false)).toBe(true);
  });
});

/**
 * Proves the P2 relink fix (`src/lib/simplefin/link.ts`) end to end: not just
 * that `external_id` gets cleared (covered in `link.test.ts`), but that a
 * real resync against the write path afterward actually resolves rather than
 * throwing a raw SqliteError off the `(account_id, external_id)` partial
 * unique index.
 */
describe("syncSimpleFin — relink then resync", () => {
  it("relinking away and back to the same feed, then resyncing, does not throw and does not duplicate the row", async () => {
    const account = seedAccount({ simplefinAccountId: "ACT-1" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    const first = await syncSimpleFin({ now: NOW }, handle.db);
    expect(first.status).toBe("synced");

    setAccountLink(account.id, "ACT-2", handle.db);
    setAccountLink(account.id, "ACT-1", handle.db);

    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    const second = await syncSimpleFin({ now: NOW }, handle.db);

    expect(second.status).toBe("up-to-date");
    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, account.id))
      .all();
    expect(rows).toHaveLength(1);
  });
});

/**
 * Documents the known, tracked P1 gap (TODOS.md: "the relink fix above stops
 * the crash but not the double-count it was meant to prevent") rather than a
 * bug in this PR's own logic — the fix deliberately ships the crash fix with
 * an honest warning instead of solving this, per the ship-review decision
 * recorded there. This test pins down TODAY's behavior so it fails loudly,
 * for the right reason, the day someone claims the P1 follow-up without
 * actually re-checking this path. Delete or update once that follow-up
 * lands.
 */
describe("syncSimpleFin — cross-account relink double-count (known P1 gap)", () => {
  it("a different account claiming a freed feed cannot see the old account's orphaned rows, so it re-imports them", async () => {
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Old Checking" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    await syncSimpleFin({ now: NOW }, handle.db);

    setAccountLink(a.id, null, handle.db);
    const b = seedAccount({ name: "New Checking" });
    setAccountLink(b.id, "ACT-1", handle.db);

    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");
    expect(outcome.insertedCount).toBe(1);

    const all = handle.db.select().from(schema.transactions).all();
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.amountCents === -487)).toHaveLength(2);
  });
});

// Same gap as the CSV path (see importBatch.test.ts): `applyRuleAtImport` was
// never called from either write path, so a synced row landed uncategorized
// even when a rule for that merchant already existed.
describe("syncSimpleFin — auto-categorization", () => {
  function categoryByName(name: string): number {
    const [category] = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, name))
      .all();
    if (!category) throw new Error(`seed category "${name}" missing`);
    return category.id;
  }

  it("applies a trained rule to rows arriving from the feed", async () => {
    const account = seedAccount({ simplefinAccountId: "ACT-1" });
    const categoryId = categoryByName("Dining");
    // The feed's description is byte-identical in shape to the CSV Memo column,
    // so a rule trained on CSV history keys straight through — this asserts the
    // match runs on `normalized_merchant`, never on MX's `payee`.
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId,
        matchType: "exact",
        matchValue: mapTransaction(feedTxn("TRN-1", "-4.87")).normalizedMerchant,
        source: "manual",
      })
      .run();

    respondWith("ACT-1", [feedTxn("TRN-1", "-4.87"), feedTxn("TRN-2", "-9.99", "UNKNOWN VENDOR")]);

    const result = await syncSimpleFin({ now: NOW }, handle.db);
    expect(result.status).toBe("synced");

    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, account.id))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.externalId === "TRN-1")?.categoryId).toBe(categoryId);
    expect(rows.find((r) => r.externalId === "TRN-2")?.categoryId).toBeNull();
  });
});
