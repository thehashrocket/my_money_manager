import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import type { SimpleFinResponse, SimpleFinTransaction } from "./types";
import {
  syncSimpleFin,
  linkTransferPairManually,
  rejectTransferPairManually,
  unlinkTransferPair,
  findLinkedTransferPairs,
  linkTransfersByBucket,
  findAmbiguousTransfers,
  findSameAccountReversalCandidates,
  refreshLiabilityBalancesOnly,
} from "./sync";
import { setAccountLink } from "./link";
import {
  loadRejectedPairs,
  pairKey,
  recordPairRejection,
} from "@/lib/transferRejections";
import { mapTransaction } from "./mapTransaction";

/**
 * Reads the rejection store the way production does, rather than poking at a
 * column. Rejections used to live on `transactions` as a single
 * self-referencing id per row; asserting through `loadRejectedPairs` means
 * these tests exercise the real reader and cannot drift from it.
 */
function isRejected(handle: TestDbHandle, aId: number, bId: number): boolean {
  return loadRejectedPairs(handle.db, [aId, bId]).has(pairKey(aId, bId));
}

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

function seedAccount(
  opts: {
    simplefinAccountId?: string | null;
    name?: string;
    type?: "checking" | "savings" | "credit" | "loan";
    startingBalanceCents?: number;
    startingBalanceDate?: string;
  } = {},
) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: opts.name ?? `Checking-${seq}`,
      type: opts.type ?? "checking",
      startingBalanceCents: opts.startingBalanceCents ?? 0,
      startingBalanceDate: opts.startingBalanceDate ?? "2026-01-01",
      simplefinAccountId: opts.simplefinAccountId ?? null,
    })
    .returning()
    .all();
  return row;
}

function seedBatch(source: "csv" | "simplefin" | "manual") {
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
  source?: "csv" | "simplefin" | "manual";
  externalId?: string | null;
  /**
   * Which feed the row came from. Defaults to the ACCOUNT's current link
   * whenever an `externalId` is given, which is the same argument migration
   * 0020's backfill makes: before provenance existed, a relink cleared
   * `external_id`, so a row that has one has never been through a relink and
   * its account's current link IS its origin.
   *
   * Pass it explicitly to build the one state that argument excludes — a row
   * whose account has since been re-pointed elsewhere.
   */
  simplefinSourceAccountId?: string | null;
}) {
  seq += 1;
  const externalId = opts.externalId ?? null;
  const linkedFeedId = externalId
    ? (handle.db
        .select({ feedId: schema.accounts.simplefinAccountId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, opts.accountId))
        .get()?.feedId ?? null)
    : null;
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
      externalId,
      simplefinSourceAccountId:
        opts.simplefinSourceAccountId !== undefined
          ? opts.simplefinSourceAccountId
          : linkedFeedId,
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

  // Red Team (`/ship` 2026-09-04): transferPairId IS NULL alone can't tell
  // "never evaluated" from "user explicitly rejected this match" apart, so
  // every automatic matcher would silently re-link a "Not a transfer"
  // correction the moment an unrelated future row landed on the same date.
  // Pair-scoped, not transaction-scoped — a transaction-scoped version was
  // tried first and reverted per Codex structured review (see the
  // `transferPairRejections` schema comment).
  it("records the unlinked pair in transfer_pair_rejections", () => {
    const { a, b } = seedLinkedPair();
    unlinkTransferPair(a.id, handle.db);
    expect(isRejected(handle, a.id, b.id)).toBe(true);
    // Stored unordered: one row answers the question from either direction,
    // which is what removed the old `a->b OR b->a` disjunction.
    expect(isRejected(handle, b.id, a.id)).toBe(true);
  });

  it("manual re-link forgets that rejection — explicit human consent overrides an earlier one", () => {
    const { a, b } = seedLinkedPair();
    unlinkTransferPair(a.id, handle.db);
    linkTransferPairManually(a.id, b.id, handle.db);
    expect(isRejected(handle, a.id, b.id)).toBe(false);
  });

  // Codex structured review (`/ship` 2026-09-04): an unconditional clear on
  // manual link would also erase a rejection recorded against a THIRD row —
  // not just the two rows being linked right now.
  it("manual link to a different row does NOT clear a rejection recorded against a third row", () => {
    const { a, b } = seedLinkedPair();
    unlinkTransferPair(a.id, handle.db); // A rejected specifically against B.

    const other = seedAccount({ name: "Other" });
    const c = seedTxn({
      accountId: other.id,
      batchId: seedBatch("csv").id,
      amountCents: -a.amountCents,
      rawMemo: "REAL TRANSFER",
      date: a.date,
    });

    linkTransferPairManually(a.id, c.id, handle.db); // A linked to C, not B.

    const rowA = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, a.id))
      .get()!;
    // A is paired with C now, but still remembers it rejected B specifically.
    expect(rowA.transferPairId).toBe(c.id);
    expect(isRejected(handle, a.id, b.id)).toBe(true);
  });
});

/**
 * Guards the fix for the gap `unlinkTransferPair`'s docstring names: without a
 * rejection store, every automatic matcher treats a rejected pair exactly like
 * a never-evaluated one, so the SAME rejected combination can silently
 * resurface once an unrelated row shares its date.
 */
describe("transfer_pair_rejections — automatic matchers never resurface a rejected pair", () => {
  it("linkTransfersByBucket does not re-link a rejected pair when a later unrelated row shares its date", () => {
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const other = seedAccount({ name: "Other" });
    const batch = seedBatch("simplefin");
    const a = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: -3000,
      rawMemo: "TRANSFER TO SAVINGS",
      date: "2026-09-05",
    });
    const b = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 3000,
      rawMemo: "TRANSFER FROM CHECKING",
      date: "2026-09-05",
    });
    linkTransferPairManually(a.id, b.id, handle.db);
    unlinkTransferPair(a.id, handle.db);

    // An unrelated row lands on the SAME date, re-entering both the bucket
    // scan's date window and the unlinked pair's own bucket key.
    seedTxn({
      accountId: other.id,
      batchId: batch.id,
      amountCents: 5000,
      rawMemo: "UNRELATED",
      date: "2026-09-05",
    });

    const { pairsLinked } = linkTransfersByBucket("2026-01-01", handle.db);
    expect(pairsLinked).toBe(0);
    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, [a.id, b.id]))
      .all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
  });

  // Codex structured review (`/ship` 2026-09-04): a rejected row must NOT
  // disappear from the review queue entirely — that would leave no UI path
  // back to `linkTransferPairManually` if the user later decides the
  // rejection was wrong, or if a genuinely different real counterpart never
  // shows up and this IS in fact the right pair after all. Since the only
  // candidate pairing for a and b is the rejected one, matchTransfers can't
  // resolve a non-rejected assignment and surfaces them as ambiguous instead
  // of silently doing nothing — a human decides, they aren't hidden.
  it("findAmbiguousTransfers still surfaces a rejected row when it's the only candidate pairing available", () => {
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("simplefin");
    const a = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: -4000,
      rawMemo: "TRANSFER",
      date: "2026-09-06",
    });
    const b = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 4000,
      rawMemo: "TRANSFER",
      date: "2026-09-06",
    });
    linkTransferPairManually(a.id, b.id, handle.db);
    unlinkTransferPair(a.id, handle.db);

    const ambiguous = findAmbiguousTransfers("2026-01-01", handle.db);
    const flatIds = ambiguous.flatMap((bucket) => [
      ...bucket.positives.map((r) => r.id),
      ...bucket.negatives.map((r) => r.id),
    ]);
    expect(flatIds).toContain(a.id);
    expect(flatIds).toContain(b.id);

    // And the escape hatch actually works: explicit re-link is still allowed.
    expect(() => linkTransferPairManually(a.id, b.id, handle.db)).not.toThrow();
  });

  // The rejection used to be a self-referencing id on EACH leg, checked as
  // `a.marker === b.id || b.marker === a.id`. That disjunction existed because
  // the relation was stored twice and the two copies could disagree, so two
  // tests were needed here — one seeding only the positive leg's marker, one
  // only the negative leg's — to prove each half of the OR was load-bearing.
  //
  // A rejection is now ONE row keyed on the unordered pair, so the two copies
  // cannot disagree and there is no OR left to be asymmetric. What still needs
  // pinning is the property that replaced it: recording a rejection must be
  // insensitive to the order the two ids arrive in, because `matchTransfers`'
  // backtracking always presents the positive-signed candidate first while the
  // review queue's form can submit either way round.
  it.each([
    ["positive leg first", true],
    ["negative leg first", false],
  ])("does not re-link a rejected pair, recorded %s", (_label, positiveFirst) => {
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("simplefin");
    const negativeLeg = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: -3000,
      rawMemo: "TRANSFER TO SAVINGS",
      date: "2026-09-07",
    });
    const positiveLeg = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 3000,
      rawMemo: "TRANSFER FROM CHECKING",
      date: "2026-09-07",
    });
    if (positiveFirst) {
      recordPairRejection(handle.db, positiveLeg.id, negativeLeg.id);
    } else {
      recordPairRejection(handle.db, negativeLeg.id, positiveLeg.id);
    }

    const { pairsLinked } = linkTransfersByBucket("2026-01-01", handle.db);
    expect(pairsLinked).toBe(0);
    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, [negativeLeg.id, positiveLeg.id]))
      .all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
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
 * The former P1 gap, now closed. This block used to PIN the double-count —
 * "a different account claiming a freed feed cannot see the old account's
 * orphaned rows, so it re-imports them" — because the fix of the day cleared
 * `external_id` on relink, which stopped the crash by erasing the only record
 * of where a row came from.
 *
 * `transactions.simplefin_source_account_id` records that provenance at write
 * time, so nothing is cleared and the id pass keys on the FEED rather than on
 * the local account. The assertions below are the exact inverse of what they
 * were; if this file ever goes back to expecting two rows, the regression is
 * the one that cost real money.
 */
describe("syncSimpleFin — cross-account relink (former P1 double-count)", () => {
  it("a different account claiming a freed feed recognizes the old account's rows and does not re-import them", async () => {
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Old Checking" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    await syncSimpleFin({ now: NOW }, handle.db);

    setAccountLink(a.id, null, handle.db);
    const b = seedAccount({ name: "New Checking" });
    setAccountLink(b.id, "ACT-1", handle.db);

    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("up-to-date");
    const all = handle.db.select().from(schema.transactions).all();
    expect(all).toHaveLength(1);
    expect(all.filter((r) => r.amountCents === -487)).toHaveLength(1);
  });

  it("keeps the row's ORIGINAL feed tag when its account is relinked, so provenance never follows the link", () => {
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    return syncSimpleFin({ now: NOW }, handle.db).then(() => {
      setAccountLink(a.id, "ACT-2", handle.db);
      const [row] = handle.db.select().from(schema.transactions).all();
      // The account now points at ACT-2; the row still came from ACT-1.
      expect(row.simplefinSourceAccountId).toBe("ACT-1");
      expect(row.externalId).toBe("TRN-a");
    });
  });

  it("re-imports under a NEW feed id only when content dedup cannot vouch for the row", async () => {
    // Re-running `simplefin:claim` mints fresh account ids for the same real
    // bank account. The id pass cannot match (the id genuinely differs), so the
    // content-dedup fallback is the only thing standing between the user and a
    // duplicated ledger — which is why it accepts rows tagged with a DIFFERENT
    // feed, not just untagged CSV rows.
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    await syncSimpleFin({ now: NOW }, handle.db);

    setAccountLink(a.id, "ACT-2", handle.db);
    respondWith("ACT-2", [feedTxn("TRN-different-id", "-4.87")]);
    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("up-to-date");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(1);
  });
});

/**
 * The dedup passes AFTER provenance: what each one can and cannot see, now that
 * the id pass is keyed on the FEED and the content pass admits rows tagged with
 * a different one. Both directions matter — a pass that sees too little
 * double-counts, and one that sees too much silently swallows real money.
 */
describe("syncSimpleFin — feed-scoped dedup, both directions", () => {
  /** Two feed accounts in one response; `respondWith` only models one. */
  function respondWithTwo(
    first: { id: string; transactions: SimpleFinTransaction[] },
    second: { id: string; transactions: SimpleFinTransaction[] },
  ): void {
    fetchAccountsMock.mockResolvedValue({
      accounts: [first, second].map((a) => ({
        id: a.id,
        name: "REGULAR SAVINGS",
        balance: "0.00",
        "available-balance": "0.00",
        "balance-date": SEP_1_NOON,
        transactions: a.transactions,
      })),
    } satisfies SimpleFinResponse);
  }

  it("keeps two rows sharing an external_id when they come from DIFFERENT feeds", async () => {
    // A SimpleFIN id is unique WITHIN its feed account, never globally. Keying
    // the id pass (or the unique index) on the id alone would drop the second
    // account's row as a phantom duplicate.
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    const b = seedAccount({ simplefinAccountId: "ACT-2", name: "Savings" });
    respondWithTwo(
      { id: "ACT-1", transactions: [feedTxn("TRN-shared", "-4.87", "MEMO A")] },
      { id: "ACT-2", transactions: [feedTxn("TRN-shared", "-4.87", "MEMO B")] },
    );

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(2);
    expect(
      rows.map((r) => [r.accountId, r.simplefinSourceAccountId, r.externalId]),
    ).toEqual([
      [a.id, "ACT-1", "TRN-shared"],
      [b.id, "ACT-2", "TRN-shared"],
    ]);
  });

  it("the unique index still refuses the SAME (feed, external_id) twice", () => {
    // The in-memory id pass is the first line; this index is the backstop that
    // makes a double-count impossible rather than merely unlikely.
    const a = seedAccount({ simplefinAccountId: "ACT-1" });
    const batch = seedBatch("simplefin");
    seedTxn({
      accountId: a.id,
      batchId: batch.id,
      amountCents: -487,
      rawMemo: COFFEE_MEMO,
      source: "simplefin",
      externalId: "TRN-a",
    });

    expect(() =>
      seedTxn({
        accountId: a.id,
        batchId: batch.id,
        amountCents: -487,
        rawMemo: "SOMETHING ELSE",
        source: "simplefin",
        externalId: "TRN-a",
      }),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("still imports GENUINELY new rows arriving under a re-minted feed id", async () => {
    // The mirror of the re-claim test above: admitting different-feed rows to
    // content dedup must not turn into "suppress everything the new feed
    // sends". Only a matching (date, amount, memo) is absorbed.
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    await syncSimpleFin({ now: NOW }, handle.db);

    setAccountLink(a.id, "ACT-2", handle.db);
    respondWith("ACT-2", [
      feedTxn("TRN-new-1", "-4.87"),
      feedTxn("TRN-new-2", "-12.00", "TRADER JOES 123 MANTECA CA"),
    ]);
    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") throw new Error("unreachable");
    expect(outcome.insertedCount).toBe(1);
    expect(outcome.accounts[0].duplicateByContent).toBe(1);
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.map((r) => r.simplefinSourceAccountId)).toEqual(["ACT-1", "ACT-2"]);
  });

  it("cannot content-vouch for a different-feed row older than the lookback floor", async () => {
    // The content fallback is bounded by MAX_LOOKBACK_DAYS, so the safety net
    // under a re-minted feed id has an edge. Pinned rather than fixed: widening
    // it would content-match against arbitrarily old history.
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    const batch = seedBatch("simplefin");
    seedTxn({
      accountId: a.id,
      batchId: batch.id,
      amountCents: -487,
      rawMemo: COFFEE_MEMO,
      date: "2026-01-05",
      source: "simplefin",
      externalId: "TRN-old",
    });

    setAccountLink(a.id, "ACT-2", handle.db);
    fetchAccountsMock.mockResolvedValue({
      accounts: [
        {
          id: "ACT-2",
          name: "REGULAR SAVINGS",
          balance: "0.00",
          "available-balance": "0.00",
          "balance-date": SEP_1_NOON,
          transactions: [
            {
              ...feedTxn("TRN-re-minted", "-4.87"),
              posted: Math.floor(new Date("2026-01-05T12:00:00Z").getTime() / 1000),
              transacted_at: Math.floor(new Date("2026-01-05T12:00:00Z").getTime() / 1000),
            },
          ],
        },
      ],
    } satisfies SimpleFinResponse);

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
  });

  it("is BLIND to a row carrying an external_id but no feed tag (the state 0020 leaves unhandled)", async () => {
    // `NULL <> 'ACT-1'` is NULL, not true, so such a row matches neither
    // `simplefin_source_account_id = feed` (the id pass) nor the content pass's
    // different-feed clause — it is invisible to both and re-imports.
    //
    // Unreachable from the app: every sync write records the feed, and nothing
    // clears external_id any more. This pins the consequence so the day some
    // path DOES produce one, the cost is written down rather than discovered.
    const a = seedAccount({ simplefinAccountId: "ACT-1" });
    const batch = seedBatch("simplefin");
    seedTxn({
      accountId: a.id,
      batchId: batch.id,
      amountCents: -487,
      rawMemo: COFFEE_MEMO,
      source: "simplefin",
      externalId: "TRN-a",
      simplefinSourceAccountId: null,
    });

    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.simplefinSourceAccountId)).toEqual([null, "ACT-1"]);
  });

  it("tags a row with the feed of the account SYNCING it, not the one that held it before", async () => {
    // Provenance is captured at write time from `account.simplefinAccountId`.
    // A second local account claiming a feed writes its OWN rows under that
    // feed — the tag follows the write, never the row's neighbours.
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Old Checking" });
    respondWith("ACT-1", [feedTxn("TRN-a", "-4.87")]);
    await syncSimpleFin({ now: NOW }, handle.db);

    setAccountLink(a.id, null, handle.db);
    const b = seedAccount({ name: "New Checking" });
    setAccountLink(b.id, "ACT-1", handle.db);
    respondWith("ACT-1", [feedTxn("TRN-b", "-9.99", "TRADER JOES 123 MANTECA CA")]);
    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    expect(outcome.status).toBe("synced");
    const written = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, b.id))
      .all();
    expect(written).toHaveLength(1);
    expect(written[0].simplefinSourceAccountId).toBe("ACT-1");
    expect(written[0].externalId).toBe("TRN-b");
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

  // Same audit trail as the CSV path — without it, undoImportCategorization
  // has no record of which sync-inserted rows a rule touched.
  it("records an import_batch_categorizations row for the matched sync row, none for the unmatched one", async () => {
    seedAccount({ simplefinAccountId: "ACT-1" });
    const categoryId = categoryByName("Dining");
    const [rule] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId,
        matchType: "exact",
        matchValue: mapTransaction(feedTxn("TRN-1", "-4.87")).normalizedMerchant,
        source: "manual",
      })
      .returning()
      .all();

    respondWith("ACT-1", [feedTxn("TRN-1", "-4.87"), feedTxn("TRN-2", "-9.99", "UNKNOWN VENDOR")]);

    const result = await syncSimpleFin({ now: NOW }, handle.db);
    if (result.status !== "synced") throw new Error("expected synced");

    const audit = handle.db
      .select()
      .from(schema.importBatchCategorizations)
      .where(eq(schema.importBatchCategorizations.importBatchId, result.batchId))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0].categoryId).toBe(categoryId);
    expect(audit[0].ruleId).toBe(rule.id);

    const matchedRow = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.externalId, "TRN-1"))
      .get();
    expect(audit[0].transactionId).toBe(matchedRow?.id);
  });
});

/**
 * E1 + E2 — the linked-account partition and the liability balance pass.
 *
 * D3=A ("the mortgage never gets a transaction row") was asserted in prose
 * across four decisions and enforced by no code. These are the tests that
 * make it a server invariant.
 */
describe("syncSimpleFin — liability partition and balance pass (E1/E2, T7)", () => {
  /** The feed returns both accounts in one response, as it really does. */
  function respondWithBoth(opts: {
    checkingId: string;
    checkingTxns: SimpleFinTransaction[];
    loanId: string;
    loanBalance: string;
    loanBalanceDate?: number | null;
    includeLoan?: boolean;
  }) {
    const accounts: SimpleFinResponse["accounts"] = [
      {
        id: opts.checkingId,
        name: "REGULAR CHECKING",
        balance: "0.00",
        "available-balance": "0.00",
        "balance-date": SEP_1_NOON,
        transactions: opts.checkingTxns,
      },
    ];
    if (opts.includeLoan !== false) {
      accounts.push({
        id: opts.loanId,
        name: "HOME MORTGAGE",
        balance: opts.loanBalance,
        "available-balance": null,
        "balance-date":
          opts.loanBalanceDate === undefined ? SEP_1_NOON : opts.loanBalanceDate,
        // The feed DOES send mortgage transactions. Staging them is the bug.
        transactions: [feedTxn("LOAN-TXN-1", "-1850.00", "MORTGAGE PAYMENT")],
      });
    }
    fetchAccountsMock.mockResolvedValue({ accounts } satisfies SimpleFinResponse);
  }

  it("does NOT stage a linked loan's transactions (F9)", async () => {
    // The failure: interest, escrow and principal rows land in the categorize
    // backlog and then in budget spend, double-counting the mortgage payment
    // already budgeted on the checking side. And it self-disables — once the
    // loan has rows, the zero-row-scoped balance pass skips it forever.
    const checking = seedAccount({ simplefinAccountId: "ACT-CHK" });
    const loan = seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [feedTxn("CHK-1", "-12.00")],
      loanId: "ACT-LOAN",
      loanBalance: "-302480.11",
    });

    await syncSimpleFin({ now: NOW }, handle.db);

    const loanRows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, loan.id))
      .all();
    expect(loanRows).toHaveLength(0);

    const checkingRows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, checking.id))
      .all();
    expect(checkingRows).toHaveLength(1);
  });

  it("still asks the feed for the loan — partition, not exclude (E2)", async () => {
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [],
      loanId: "ACT-LOAN",
      loanBalance: "-302480.11",
    });

    await syncSimpleFin({ now: NOW }, handle.db);

    // Dropping liability ids from `linked` would also drop them here, and
    // then there would be no balance for the pass to write.
    const [, opts] = fetchAccountsMock.mock.calls[0];
    expect(opts.accountIds).toContain("ACT-LOAN");
    expect(opts.accountIds).toContain("ACT-CHK");
  });

  it("moves the loan's anchor and records the prior value (D7, E19)", async () => {
    const loan = seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [],
      loanId: "ACT-LOAN",
      loanBalance: "-302480.11",
    });

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    const after = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, loan.id))
      .get();
    expect(after?.startingBalanceCents).toBe(-30_248_011);
    expect(after?.balanceSource).toBe("feed");
    expect(after?.balanceAsOf).toBeInstanceOf(Date);
    // E19 — there is no batch to hang the prior anchor on, so it goes on the
    // account row. This is the mechanism /accounts/error.tsx reassures with.
    expect(after?.priorStartingBalanceCents).toBe(-30_000_000);
    expect(after?.priorStartingBalanceDate).toBe("2026-08-01");

    expect(outcome.status).not.toBe("no-linked-accounts");
    if (outcome.status !== "no-linked-accounts") {
      expect(outcome.balanceUpdates).toHaveLength(1);
      expect(outcome.balanceUpdates[0]).toMatchObject({
        name: "Mortgage",
        balanceCents: -30_248_011,
        priorBalanceCents: -30_000_000,
      });
    }
  });

  it("writes NO transaction rows and NO import batch for the balance pass", async () => {
    seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [],
      loanId: "ACT-LOAN",
      loanBalance: "-302480.11",
    });

    await syncSimpleFin({ now: NOW }, handle.db);

    // An anchor move is not an import, and undoSyncBatch deletes rows only.
    expect(handle.db.select().from(schema.importBatches).all()).toHaveLength(0);
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("REPORTS the anchor move through the up-to-date early return (F8)", async () => {
    // syncSimpleFin returns "up-to-date" before any write when nothing is
    // inserted, and /sync renders that as "nothing new to import". A balance
    // pass behind that return would mutate state while the UI denied it.
    seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [],
      loanId: "ACT-LOAN",
      loanBalance: "-302480.11",
    });

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);
    expect(outcome.status).toBe("up-to-date");
    if (outcome.status === "up-to-date") {
      expect(outcome.balanceUpdates).toHaveLength(1);
    }
  });

  it("SKIPS and warns when the provider sends no balance-date (D15)", async () => {
    // balance-date is a nullable instant. Without one there is no defensible
    // anchor date: today would assert a close-of-day balance for a figure
    // that might be weeks old, and silently reset DS57's staleness clock.
    const loan = seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [],
      loanId: "ACT-LOAN",
      loanBalance: "-302480.11",
      loanBalanceDate: null,
    });

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    const after = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, loan.id))
      .get();
    expect(after?.startingBalanceCents).toBe(-30_000_000);
    if (outcome.status !== "no-linked-accounts") {
      expect(outcome.balanceUpdates).toHaveLength(0);
      expect(outcome.warnings.join(" ")).toContain("no date for it");
    }
  });

  it("warns on its own when the feed omits the liability entirely (F4)", async () => {
    // The staging loop has this warning; a balance-only account is not in
    // that loop, so without its own the mortgage would go completely silent.
    seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [],
      loanId: "ACT-LOAN",
      loanBalance: "0",
      includeLoan: false,
    });

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);
    if (outcome.status !== "no-linked-accounts") {
      expect(outcome.warnings.join(" ")).toContain("Mortgage");
    }
  });

  it("REFUSES to refresh a liability that has transaction rows (D15, E16)", async () => {
    // Credit cards get manual reconcile only: balance-date is an instant, so
    // collapsing it to a date on an account WITH rows silently drops every
    // row later that same day out of the balance.
    const card = seedAccount({
      simplefinAccountId: "ACT-CARD",
      name: "Visa",
      type: "credit",
      startingBalanceCents: -200_000,
      startingBalanceDate: "2026-08-01",
    });
    const batch = seedBatch("manual");
    seedTxn({
      accountId: card.id,
      batchId: batch.id,
      amountCents: -8_000,
      rawMemo: "COSTCO",
      source: "manual",
    });
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [],
      loanId: "ACT-CARD",
      loanBalance: "-1580.00",
    });

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    const after = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, card.id))
      .get();
    expect(after?.startingBalanceCents).toBe(-200_000);
    if (outcome.status !== "no-linked-accounts") {
      expect(outcome.balanceUpdates).toHaveLength(0);
      expect(outcome.warnings.join(" ")).toContain("has transactions");
    }
  });

  it("does not report an update when the feed's balance already matches", async () => {
    seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_248_011,
      startingBalanceDate: "2026-09-01",
    });
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    respondWithBoth({
      checkingId: "ACT-CHK",
      checkingTxns: [],
      loanId: "ACT-LOAN",
      loanBalance: "-302480.11",
    });

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);
    if (outcome.status !== "no-linked-accounts") {
      expect(outcome.balanceUpdates).toHaveLength(0);
    }
  });
});

describe("D11 — a manual row is never an automatic transfer-matcher candidate", () => {
  it("does NOT auto-pair a manual card charge with an unrelated same-day deposit (F1)", () => {
    // The concrete failure: a $250 charge on the Visa dated 09-15 and a $250
    // reimbursement into checking on 09-15 form a balanced 1-and-1 bucket,
    // which the counting argument auto-links WITHOUT ASKING. Neither leg has
    // a bank_transaction_number, so the cross-source guard never fires
    // either, and both rows silently leave every spend sum.
    const checking = seedAccount({ name: "Checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const manual = seedBatch("manual");
    const csv = seedBatch("csv");

    const charge = seedTxn({
      accountId: visa.id,
      batchId: manual.id,
      amountCents: -25_000,
      rawMemo: "COSTCO WHOLESALE",
      date: "2026-09-15",
      source: "manual",
    });
    const reimbursement = seedTxn({
      accountId: checking.id,
      batchId: csv.id,
      amountCents: 25_000,
      rawMemo: "DEPOSIT",
      date: "2026-09-15",
    });

    const result = linkTransfersByBucket("2026-09-01", handle.db);
    expect(result.pairsLinked).toBe(0);

    for (const id of [charge.id, reimbursement.id]) {
      const row = handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, id))
        .get();
      expect(row?.transferPairId).toBeNull();
    }
  });

  it("keeps manual rows out of the ambiguous review queue too", () => {
    const checking = seedAccount({ name: "Checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const manual = seedBatch("manual");
    const csv = seedBatch("csv");

    seedTxn({
      accountId: visa.id,
      batchId: manual.id,
      amountCents: -25_000,
      rawMemo: "COSTCO",
      date: "2026-09-15",
      source: "manual",
    });
    seedTxn({
      accountId: checking.id,
      batchId: csv.id,
      amountCents: 25_000,
      rawMemo: "DEPOSIT",
      date: "2026-09-15",
    });
    seedTxn({
      accountId: checking.id,
      batchId: csv.id,
      amountCents: 25_000,
      rawMemo: "DEPOSIT 2",
      date: "2026-09-15",
    });

    expect(findAmbiguousTransfers("2026-09-01", handle.db)).toHaveLength(0);
  });

  it("still pairs two ordinary non-manual rows on the same day and amount", () => {
    // Guard against over-filtering: the exclusion must not disturb the
    // matcher's real job.
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const csv = seedBatch("csv");

    const out = seedTxn({
      accountId: checking.id,
      batchId: csv.id,
      amountCents: -25_000,
      rawMemo: "TRANSFER",
      date: "2026-09-15",
    });
    const inn = seedTxn({
      accountId: savings.id,
      batchId: csv.id,
      amountCents: 25_000,
      rawMemo: "TRANSFER",
      date: "2026-09-15",
    });

    expect(linkTransfersByBucket("2026-09-01", handle.db).pairsLinked).toBe(1);
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, out.id))
      .get();
    expect(row?.transferPairId).toBe(inn.id);
  });
});

describe("REGRESSION R1 — syncSimpleFin feeds resolveStartDate the ASSET partition only", () => {
  it("does not widen the fetch window to the 45-day floor because of a zero-row loan", async () => {
    // The end-to-end half of R1. The checking account has recent history, so
    // the window should start a week before it. Before the partition, the
    // mortgage's permanent null pinned every sync to the floor forever.
    const checking = seedAccount({ simplefinAccountId: "ACT-CHK" });
    const batch = seedBatch("simplefin");
    seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: -1_200,
      rawMemo: "COFFEE",
      date: "2026-09-01",
      source: "simplefin",
      externalId: "SEEDED-1",
    });
    seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });

    fetchAccountsMock.mockResolvedValue({
      accounts: [
        {
          id: "ACT-CHK",
          name: "REGULAR CHECKING",
          balance: "0.00",
          "available-balance": "0.00",
          "balance-date": SEP_1_NOON,
          transactions: [],
        },
        {
          id: "ACT-LOAN",
          name: "HOME MORTGAGE",
          balance: "-302480.11",
          "available-balance": null,
          "balance-date": SEP_1_NOON,
          transactions: [],
        },
      ],
    } satisfies SimpleFinResponse);

    await syncSimpleFin({ now: NOW }, handle.db);

    // 2026-09-01 minus the 7-day overlap. The 45-day floor would be
    // 2026-07-19, and asking for that window every run re-checks six weeks of
    // already-imported rows through content dedup on every sync.
    const [, opts] = fetchAccountsMock.mock.calls[0];
    const startIso = new Date(opts.startDate * 1000).toISOString().slice(0, 10);
    expect(startIso).toBe("2026-08-25");
    expect(startIso).not.toBe("2026-07-19");
  });
});

/**
 * THE SIGN, on the app's only untrusted input.
 *
 * This is the one anchor writer that does not route through
 * `owedDollarsToSignedCents` — it stores whatever the provider sends, with no
 * human in the loop. It validated range, date shape and future-dating, and
 * never the sign. Every fixture above passes a negative or "0", so a provider
 * reporting a balance as positive amount-owed had no coverage at all.
 */
describe("refreshLiabilityBalances — the sign guard (rule 9)", () => {
  const SEP_1 = Math.floor(new Date("2026-09-01T12:00:00Z").getTime() / 1000);

  function respondWithLoanBalance(balance: string, name = "HOME MORTGAGE") {
    fetchAccountsMock.mockResolvedValue({
      accounts: [
        {
          id: "ACT-LIAB",
          name,
          balance,
          "available-balance": null,
          "balance-date": SEP_1,
          transactions: [],
        },
      ],
    } satisfies SimpleFinResponse);
  }

  it("REFUSES a positive balance on a loan and leaves the anchor alone", () => {
    // A mortgage cannot be a credit balance. Writing +30,248,011 would put
    // the debt on the asset side of net worth: `summarizeBalances` adds it to
    // the liabilities total as a positive and `moneyTone` paints it green,
    // leaving net worth wrong by twice the mortgage with nothing on screen to
    // say so.
    const loan = seedAccount({
      simplefinAccountId: "ACT-LIAB",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    respondWithLoanBalance("302480.11");

    return syncSimpleFin({ now: NOW }, handle.db).then((outcome) => {
      const after = handle.db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, loan.id))
        .get();
      expect(after?.startingBalanceCents).toBe(-30_000_000);
      expect(after?.startingBalanceDate).toBe("2026-08-01");
      // Untouched means untouched: the undo slot is not spent either.
      expect(after?.priorStartingBalanceCents).toBeNull();
      // And it is not silent.
      expect(outcome.status).not.toBe("no-linked-accounts");
      if (outcome.status !== "no-linked-accounts") {
        expect(outcome.warnings.join(" ")).toContain("Mortgage");
        expect(outcome.balanceUpdates).toHaveLength(0);
      }
    });
  });

  it("ALLOWS a positive balance on a credit card, but says so", async () => {
    // A card genuinely can carry a credit balance after an overpayment, and
    // `summarizeBalances` treats one as real. Refusing here would strand a
    // zero-row feed-linked card with no working control at all, since
    // `resolveBalanceAction` gives it Refresh rather than Reconcile (E4).
    const card = seedAccount({
      simplefinAccountId: "ACT-LIAB",
      name: "Visa",
      type: "credit",
      startingBalanceCents: -200_000,
      startingBalanceDate: "2026-08-01",
    });
    respondWithLoanBalance("125.00", "VISA");

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    const after = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, card.id))
      .get();
    expect(after?.startingBalanceCents).toBe(12_500);
    if (outcome.status !== "no-linked-accounts") {
      expect(outcome.warnings.join(" ")).toContain("Visa");
    }
  });

  it("still writes an ordinary negative balance with no warning about it", async () => {
    const loan = seedAccount({
      simplefinAccountId: "ACT-LIAB",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    respondWithLoanBalance("-302480.11");

    const outcome = await syncSimpleFin({ now: NOW }, handle.db);

    const after = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, loan.id))
      .get();
    expect(after?.startingBalanceCents).toBe(-30_248_011);
    if (outcome.status !== "no-linked-accounts") {
      expect(outcome.warnings.join(" ")).not.toContain("Mortgage");
    }
  });
});

/**
 * `/accounts`' per-row Refresh used to call `syncSimpleFin({})` — the entire
 * import — and then report one balance, discarding `snapshot.consistent`,
 * `response.errors`, the import counts and the ambiguous buckets. Clicking
 * Refresh on the mortgage row imported forty checking transactions and said
 * "Mortgage is unchanged."
 */
describe("refreshLiabilityBalancesOnly — the balance pass alone", () => {
  const SEP_1 = Math.floor(new Date("2026-09-01T12:00:00Z").getTime() / 1000);

  it("moves the liability anchor WITHOUT importing any transactions", async () => {
    const checking = seedAccount({ simplefinAccountId: "ACT-CHK" });
    const loan = seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    // The feed offers checking transactions; a balance-only refresh must not
    // take them, and must not create a batch to hold them.
    fetchAccountsMock.mockResolvedValue({
      accounts: [
        {
          id: "ACT-CHK",
          name: "REGULAR CHECKING",
          balance: "0.00",
          "available-balance": "0.00",
          "balance-date": SEP_1,
          transactions: [feedTxn("CHK-1", "-12.00")],
        },
        {
          id: "ACT-LOAN",
          name: "HOME MORTGAGE",
          balance: "-302480.11",
          "available-balance": null,
          "balance-date": SEP_1,
          transactions: [feedTxn("LOAN-1", "-1850.00", "MORTGAGE PAYMENT")],
        },
      ],
    } satisfies SimpleFinResponse);

    const outcome = await refreshLiabilityBalancesOnly({ now: NOW }, handle.db);

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.updates).toHaveLength(1);
      expect(outcome.updates[0].accountId).toBe(loan.id);
    }
    // The anchor moved...
    const after = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, loan.id))
      .get();
    expect(after?.startingBalanceCents).toBe(-30_248_011);
    // ...and nothing was imported, for either account.
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
    expect(handle.db.select().from(schema.importBatches).all()).toHaveLength(0);
    expect(checking.id).toBeGreaterThan(0);
  });

  it("asks the feed for balances only, and only for the liabilities", async () => {
    seedAccount({ simplefinAccountId: "ACT-CHK" });
    seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    fetchAccountsMock.mockResolvedValue({ accounts: [] } satisfies SimpleFinResponse);

    await refreshLiabilityBalancesOnly({ now: NOW }, handle.db);

    const [, opts] = fetchAccountsMock.mock.calls[0];
    expect(opts.balancesOnly).toBe(true);
    expect(opts.accountIds).toEqual(["ACT-LOAN"]);
  });

  it("SURFACES a broken bank connection instead of reporting nothing", async () => {
    // SimpleFIN reports a dead connection in `errors[]` on an HTTP 200.
    // Dropping these is what `sync/actions.ts` documents as having made a dead
    // connection render as a green "Already up to date".
    seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    fetchAccountsMock.mockResolvedValue({
      accounts: [],
      errors: ["Connection to Star One CU failed"],
    } satisfies SimpleFinResponse);

    const outcome = await refreshLiabilityBalancesOnly({ now: NOW }, handle.db);

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.updates).toHaveLength(0);
      // The old code matched warnings by `w.includes(account.name)`, and this
      // string contains no local account name — so it found nothing and
      // claimed "the bank reports the same balance".
      expect(outcome.warnings).toContain("Connection to Star One CU failed");
    }
  });

  it("reports no linked accounts rather than pretending success", async () => {
    seedAccount({ simplefinAccountId: null });
    const outcome = await refreshLiabilityBalancesOnly({ now: NOW }, handle.db);
    expect(outcome.status).toBe("no-linked-accounts");
  });
});

/**
 * `NOT_MANUAL` guards `linkTransfersByBucket` and `findAmbiguousTransfers`,
 * and this query was missed out of it — so a hand-marked card payment showed
 * up in `/sync`'s linked-transfer list beside a "Not a transfer" button wired
 * to `unlinkTransferPair`. `unmarkCardPayment`'s docstring spells out what
 * that does to a synthetic mirror: an orphan row in the categorize backlog,
 * the card balance still inflated by the payment, no valid category, and a
 * rejection marker blocking automatic re-pairing. None of it announced.
 */
describe("findLinkedTransferPairs — hand-marked card payments are not sync's business", () => {
  it("EXCLUDES a pair whose mirror was created by hand", () => {
    const checking = seedAccount({ name: "Checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const csvBatch = seedBatch("csv");
    const manualBatch = seedBatch("manual");

    const debit = seedTxn({
      accountId: checking.id,
      batchId: csvBatch.id,
      amountCents: -50_000,
      rawMemo: "PAYMENT",
      date: "2026-09-05",
    });
    const mirror = seedTxn({
      accountId: visa.id,
      batchId: manualBatch.id,
      amountCents: 50_000,
      rawMemo: "PAYMENT TO VISA",
      date: "2026-09-05",
      source: "manual",
    });
    linkTransferPairManually(debit.id, mirror.id, handle.db);

    // The pair genuinely exists in the ledger...
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId !== null)).toBe(true);

    // ...and it does not belong on the surface that offers to un-link what
    // THIS SYNC auto-linked. Its correct inverse is unmarkCardPayment (E12).
    expect(findLinkedTransferPairs("2026-01-01", handle.db)).toEqual([]);
  });

  it("still lists an ordinary bank-to-bank pair", () => {
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const a = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: 20_000,
      rawMemo: "DEPOSIT-OVERDRAFT",
      date: "2026-09-01",
    });
    const b = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -20_000,
      rawMemo: "WITHDRAWAL-OVERDRAFT",
      date: "2026-09-01",
    });
    linkTransferPairManually(a.id, b.id, handle.db);

    expect(findLinkedTransferPairs("2026-01-01", handle.db).length).toBe(1);
  });
});

/**
 * Second-pass fixes: the per-row Refresh must not act on, or report about,
 * accounts other than its own, and the card credit-balance notice must not
 * re-fire on an account that hasn't changed.
 */
describe("refreshLiabilityBalancesOnly — scoping and warning placement", () => {
  const SEP_1 = Math.floor(new Date("2026-09-01T12:00:00Z").getTime() / 1000);

  function seedTwoLiabilities() {
    const loan = seedAccount({
      simplefinAccountId: "ACT-LOAN",
      name: "Mortgage",
      type: "loan",
      startingBalanceCents: -30_000_000,
      startingBalanceDate: "2026-08-01",
    });
    const card = seedAccount({
      simplefinAccountId: "ACT-VISA",
      name: "Visa",
      type: "credit",
      startingBalanceCents: -200_000,
      startingBalanceDate: "2026-08-01",
    });
    return { loan, card };
  }

  it("does NOT move another liability's anchor, so its undo slot survives", async () => {
    const { loan, card } = seedTwoLiabilities();
    fetchAccountsMock.mockResolvedValue({
      accounts: [
        {
          id: "ACT-LOAN",
          name: "HOME MORTGAGE",
          balance: "-302480.11",
          "available-balance": null,
          "balance-date": SEP_1,
          transactions: [],
        },
        {
          id: "ACT-VISA",
          name: "VISA",
          balance: "-2148.32",
          "available-balance": null,
          "balance-date": SEP_1,
          transactions: [],
        },
      ],
    } satisfies SimpleFinResponse);

    await refreshLiabilityBalancesOnly({ now: NOW, accountId: loan.id }, handle.db);

    const visaAfter = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, card.id))
      .get();
    // Untouched — anchor unchanged and, critically, the single
    // prior_starting_balance_* slot not spent on a row the user never clicked.
    expect(visaAfter?.startingBalanceCents).toBe(-200_000);
    expect(visaAfter?.priorStartingBalanceCents).toBeNull();
  });

  it("asks the feed only for the scoped account", async () => {
    const { loan } = seedTwoLiabilities();
    fetchAccountsMock.mockResolvedValue({ accounts: [] } satisfies SimpleFinResponse);

    await refreshLiabilityBalancesOnly({ now: NOW, accountId: loan.id }, handle.db);

    const [, opts] = fetchAccountsMock.mock.calls[0];
    expect(opts.accountIds).toEqual(["ACT-LOAN"]);
  });

  it("does not report another account's warning", async () => {
    const { loan } = seedTwoLiabilities();
    // The feed returns nothing at all: unscoped, this produced a warning per
    // liability, and the action rendered the union under one row's button.
    fetchAccountsMock.mockResolvedValue({ accounts: [] } satisfies SimpleFinResponse);

    const outcome = await refreshLiabilityBalancesOnly(
      { now: NOW, accountId: loan.id },
      handle.db,
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.warnings.join(" ")).not.toContain("Visa");
      expect(outcome.warnings.join(" ")).toContain("Mortgage");
    }
  });

  it("stops warning about a credit balance once it has settled", async () => {
    // The notice is worth making when the balance is WRITTEN. Re-emitting it
    // on every later refresh made a healthy overpaid card render a permanent
    // red error, because the action treats "no update + a warning" as failure.
    const card = seedAccount({
      simplefinAccountId: "ACT-VISA",
      name: "Visa",
      type: "credit",
      startingBalanceCents: -200_000,
      startingBalanceDate: "2026-08-01",
    });
    fetchAccountsMock.mockResolvedValue({
      accounts: [
        {
          id: "ACT-VISA",
          name: "VISA",
          balance: "21.48",
          "available-balance": null,
          "balance-date": SEP_1,
          transactions: [],
        },
      ],
    } satisfies SimpleFinResponse);

    const first = await refreshLiabilityBalancesOnly(
      { now: NOW, accountId: card.id },
      handle.db,
    );
    // First time: written, and announced.
    if (first.status === "ok") {
      expect(first.updates).toHaveLength(1);
      expect(first.warnings.join(" ")).toContain("credit balance");
    }

    const second = await refreshLiabilityBalancesOnly(
      { now: NOW, accountId: card.id },
      handle.db,
    );
    // Second time: nothing moved, so nothing to say.
    if (second.status === "ok") {
      expect(second.updates).toHaveLength(0);
      expect(second.warnings).toEqual([]);
    }
  });
});

describe("linkTransferPairManually — same-account reversals (opt-in only)", () => {
  it("still refuses a same-account pair by default, so every existing caller keeps the old guard", () => {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const out = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -25000,
      rawMemo: "A2AXFER 000000000-1 Ref# 7F254",
    });
    const back = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 25000,
      rawMemo: "A2AXFER 000000000-1 Ref# 64590 reverse",
    });

    expect(() => linkTransferPairManually(out.id, back.id, handle.db)).toThrow(
      /two different accounts/,
    );
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
  });

  it("links a same-day same-account reversal when the review queue opts in", () => {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const out = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -25000,
      rawMemo: "A2AXFER 000000000-1 Ref# 7F254",
    });
    const back = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 25000,
      rawMemo: "A2AXFER 000000000-1 Ref# 64590 reverse",
    });

    linkTransferPairManually(out.id, back.id, handle.db, {
      allowSameAccountReversal: true,
    });

    const rows = handle.db.select().from(schema.transactions).all();
    const a = rows.find((r) => r.id === out.id)!;
    const b = rows.find((r) => r.id === back.id)!;
    expect(a.transferPairId).toBe(back.id);
    expect(b.transferPairId).toBe(out.id);
  });

  it("refuses a same-account pair on different dates even with the opt-in", () => {
    // The opt-in authorizes the CLASS, not any two rows. Without this, the flag
    // would accept two opposite-sign rows of equal size anywhere in one
    // account's history — a shape no reviewer is ever shown.
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const out = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -25000,
      rawMemo: "CHARGE",
      date: "2026-09-01",
    });
    const back = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 25000,
      rawMemo: "UNRELATED CREDIT",
      date: "2026-09-02",
    });

    expect(() =>
      linkTransferPairManually(out.id, back.id, handle.db, {
        allowSameAccountReversal: true,
      }),
    ).toThrow(/same-day/);
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
  });

  it("still enforces opposite signs and equal amounts under the opt-in", () => {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const out = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -25000,
      rawMemo: "CHARGE",
    });
    const sameSign = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -25000,
      rawMemo: "ANOTHER CHARGE",
    });
    const wrongAmount = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 24000,
      rawMemo: "CLOSE BUT NOT EQUAL",
    });

    expect(() =>
      linkTransferPairManually(out.id, sameSign.id, handle.db, {
        allowSameAccountReversal: true,
      }),
    ).toThrow(/opposite signs/);
    expect(() =>
      linkTransferPairManually(out.id, wrongAmount.id, handle.db, {
        allowSameAccountReversal: true,
      }),
    ).toThrow(/equal absolute amounts/);
  });

  it("rejectTransferPairManually records a rejection WITHOUT linking first", () => {
    // The gap this closes: `unlinkTransferPair` returns early on an unpaired
    // row, so the only route to a durable rejection used to be create-then-undo
    // — which hides both rows from every spending surface in between.
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const charge = seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: -399, rawMemo: "APPLE.COM/BILL" });
    const refund = seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: 399, rawMemo: "ATM Surcharge fees refund" });

    rejectTransferPairManually(refund.id, charge.id, handle.db);

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, [charge.id, refund.id]))
      .all();
    // Rejection recorded...
    expect(isRejected(handle, charge.id, refund.id)).toBe(true);
    // ...and NOTHING was ever linked, so neither row left spending.
    expect(after.every((r) => r.transferPairId === null)).toBe(true);
  });

  it("a rejection recorded this way actually removes the bucket from the queue", () => {
    // End-to-end: the module docstring promises a one-vs-one bucket "disappears
    // for good the first time the user says not a transfer". Until the reject
    // path existed, that promise was unreachable from the UI.
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const charge = seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: -1175, rawMemo: "AMAZON MKTPL" });
    const refund = seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: 1175, rawMemo: "AMAZON MKTPLACE PMT" });

    expect(findSameAccountReversalCandidates("2026-01-01", handle.db)).toHaveLength(1);
    rejectTransferPairManually(refund.id, charge.id, handle.db);
    expect(findSameAccountReversalCandidates("2026-01-01", handle.db)).toEqual([]);
  });

  it("refuses to reject a pair that is already linked — that is unlink's job", () => {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const a = seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: -1000, rawMemo: "OUT" });
    const b = seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: 1000, rawMemo: "BACK" });
    linkTransferPairManually(b.id, a.id, handle.db, { allowSameAccountReversal: true });

    expect(() => rejectTransferPairManually(b.id, a.id, handle.db)).toThrow(/already paired/);
  });

  it("refuses to pair a HAND-ENTERED row as a reversal, even with the opt-in", () => {
    // The queue never offers a manual row (findSameAccountReversalCandidates
    // filters NOT_MANUAL), but the opt-in is carried by WHICH ACTION RAN, not by
    // proof the ids came from the queue — so the linker re-asserts it. Flagged
    // by Codex adversarial review during /ship 2026-09-08: pairing a manual row
    // hides it from every spend surface, and `unmarkCardPayment` refuses a pair
    // it did not create, so there would be no ordinary way to undo it.
    const card = seedAccount({ name: "Visa" });
    const batch = seedBatch("csv");
    const manual = seedTxn({
      accountId: card.id,
      batchId: batch.id,
      amountCents: -5000,
      rawMemo: "HAND ENTERED CHARGE",
      source: "manual",
    });
    const credit = seedTxn({
      accountId: card.id,
      batchId: batch.id,
      amountCents: 5000,
      rawMemo: "PROVISIONAL CREDIT",
    });

    expect(() =>
      linkTransferPairManually(credit.id, manual.id, handle.db, {
        allowSameAccountReversal: true,
      }),
    ).toThrow(/hand-entered/i);

    // Neither leg moved.
    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, [manual.id, credit.id]))
      .all();
    expect(after.every((r) => r.transferPairId === null)).toBe(true);
  });

  it("records a rejection that survives, so a dismissed reversal stops resurfacing", () => {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const charge = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -1175,
      rawMemo: "AMAZON MKTPL*5Q7K15",
    });
    const refund = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 1175,
      rawMemo: "AMAZON MKTPLACE PMT",
    });

    linkTransferPairManually(charge.id, refund.id, handle.db, {
      allowSameAccountReversal: true,
    });
    unlinkTransferPair(charge.id, handle.db);

    const rows = handle.db.select().from(schema.transactions).all();
    const a = rows.find((r) => r.id === charge.id)!;
    const b = rows.find((r) => r.id === refund.id)!;
    expect(a.transferPairId).toBeNull();
    expect(b.transferPairId).toBeNull();
    // Pair-scoped rejection — this is what makes findSameAccountReversals drop
    // the bucket on the next render.
    expect(isRejected(handle, charge.id, refund.id)).toBe(true);
  });
});

/**
 * The DB half of the same-account reversal queue. `sameAccountReversals.test.ts`
 * covers the bucketing argument against synthetic rows; this covers the four
 * things the QUERY decides — the date window, the already-paired filter,
 * NOT_MANUAL, and the rejection-predicate wiring — none of which that file can see.
 */
/**
 * The two defects that made rejections a TABLE instead of a column.
 *
 * Both were live on the real ledger and both fail silently — a wrong number,
 * not an error — so each one is pinned end-to-end through the real store
 * rather than against the pure bucketing function, which cannot see either.
 */
describe("rejection storage — the two failures a single column could not avoid", () => {
  /** N positives and M negatives, one account, one date, one magnitude. */
  function seedReversalBucket(positives: number, negatives: number) {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const pos = Array.from({ length: positives }, (_, i) =>
      seedTxn({
        accountId: savings.id,
        batchId: batch.id,
        amountCents: 1000,
        rawMemo: `CREDIT ${i}`,
        date: "2026-09-04",
      }),
    );
    const neg = Array.from({ length: negatives }, (_, i) =>
      seedTxn({
        accountId: savings.id,
        batchId: batch.id,
        amountCents: -1000,
        rawMemo: `CHARGE ${i}`,
        date: "2026-09-04",
      }),
    );
    return { pos, neg };
  }

  // NON-CONVERGENCE. `findSameAccountReversals` drops a bucket only once EVERY
  // positive/negative combination is rejected. While a rejection was one id per
  // row, P*N combinations competed for P+N slots and each click destroyed the
  // two markers already on those rows — so for P>=2 AND N>=2 the all-rejected
  // state was UNREACHABLE (proved by exhaustive search over the reachable
  // states; a 2x2 bucket peaks at 3 of 4 covered). The queue could not be
  // dismissed and claimed otherwise every time. Live on the real ledger as a
  // 2x4 bucket, which is the very cluster this feature was built for.
  it.each([
    [2, 2],
    [2, 4],
  ])(
    "a %ix%i bucket disappears once every combination is rejected",
    (positives, negatives) => {
      const { pos, neg } = seedReversalBucket(positives, negatives);
      expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toHaveLength(1);

      for (const p of pos) {
        for (const n of neg) rejectTransferPairManually(p.id, n.id, handle.db);
      }

      expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toEqual([]);
    },
  );

  it("keeps surfacing a bucket while any one combination is still unanswered", () => {
    const { pos, neg } = seedReversalBucket(2, 2);
    // Every combination but one — rejecting is not a bulk dismissal.
    rejectTransferPairManually(pos[0].id, neg[0].id, handle.db);
    rejectTransferPairManually(pos[0].id, neg[1].id, handle.db);
    rejectTransferPairManually(pos[1].id, neg[0].id, handle.db);

    expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toHaveLength(1);
  });

  // ERASURE. Rejecting (A,C) used to overwrite A's existing rejection of B,
  // because one row held one partner. Two clicks in the reversal queue could
  // clear both legs of an unrelated "Not a transfer", after which the automatic
  // matcher re-linked the exact pair the user had rejected — silently dropping
  // both rows out of every spending total.
  it("a new rejection never erases an existing one against a third row", () => {
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const a = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: -1000,
      rawMemo: "CHARGE",
      date: "2026-09-04",
    });
    const b = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 1000,
      rawMemo: "CROSS-ACCOUNT CREDIT",
      date: "2026-09-04",
    });
    // The user's cross-account correction: A and B are NOT a transfer.
    rejectTransferPairManually(a.id, b.id, handle.db);

    // Same date, same magnitude, on each of their own accounts — so each forms
    // a same-account reversal candidate with its neighbour.
    const aPartner = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      amountCents: 1000,
      rawMemo: "SAME-ACCOUNT CREDIT",
      date: "2026-09-04",
    });
    const bPartner = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -1000,
      rawMemo: "SAME-ACCOUNT CHARGE",
      date: "2026-09-04",
    });
    rejectTransferPairManually(aPartner.id, a.id, handle.db);
    rejectTransferPairManually(b.id, bPartner.id, handle.db);

    // The original correction is intact...
    expect(isRejected(handle, a.id, b.id)).toBe(true);

    // ...so the matcher still refuses to put A and B together. It is free to
    // link the OTHER cross-account pair in this bucket (aPartner/bPartner),
    // which nobody rejected — asserting `pairsLinked === 0` here would be
    // asserting that a rejection suppresses unrelated rows, which is exactly
    // the transaction-scoped behaviour rule 4 rejected.
    linkTransfersByBucket("2026-08-01", handle.db);
    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(inArray(schema.transactions.id, [a.id, b.id]))
      .all();
    const rowA = rows.find((r) => r.id === a.id)!;
    const rowB = rows.find((r) => r.id === b.id)!;
    expect(rowA.transferPairId).not.toBe(b.id);
    expect(rowB.transferPairId).not.toBe(a.id);
  });

  it("re-rejecting an already-rejected pair is a no-op, not a duplicate or a throw", () => {
    const { pos, neg } = seedReversalBucket(1, 1);
    rejectTransferPairManually(pos[0].id, neg[0].id, handle.db);
    expect(() =>
      // Reversed argument order too: the pair is stored unordered.
      rejectTransferPairManually(neg[0].id, pos[0].id, handle.db),
    ).not.toThrow();
    expect(handle.db.select().from(schema.transferPairRejections).all()).toHaveLength(1);
  });
});

describe("findSameAccountReversalCandidates — the query around the bucketing", () => {
  it("surfaces a same-account, same-day, equal-magnitude, opposite-sign pair", () => {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const out = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -25000,
      rawMemo: "A2AXFER 000000000-1 Ref# 7F254",
      date: "2026-09-01",
    });
    const back = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: 25000,
      rawMemo: "A2AXFER 000000000-1 Ref# 64590 reverse",
      date: "2026-09-01",
    });

    const buckets = findSameAccountReversalCandidates("2026-08-01", handle.db);

    expect(buckets).toHaveLength(1);
    expect(buckets[0].reason).toBe("same-account");
    expect(buckets[0].absAmountCents).toBe(25000);
    expect(buckets[0].positives.map((r) => r.id)).toEqual([back.id]);
    expect(buckets[0].negatives.map((r) => r.id)).toEqual([out.id]);
  });

  it("leaves a CROSS-account pair to findAmbiguousTransfers and returns nothing", () => {
    // The two queues must not double-report the same rows: one bucket appearing
    // under both headings gives the user two contradictory buttons for it.
    const checking = seedAccount({ name: "Checking" });
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    seedTxn({ accountId: checking.id, batchId: batch.id, amountCents: -25000, rawMemo: "OUT", date: "2026-09-01" });
    seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: 25000, rawMemo: "IN", date: "2026-09-01" });

    expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toEqual([]);
    // And the rows are a genuine transfer the OTHER path owns, not an inert
    // fixture that nothing would have matched anyway.
    expect(linkTransfersByBucket("2026-08-01", handle.db).pairsLinked).toBe(1);
  });

  it("excludes rows older than the review window", () => {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: -25000, rawMemo: "OLD OUT", date: "2026-07-01" });
    seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: 25000, rawMemo: "OLD BACK", date: "2026-07-01" });

    expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toEqual([]);
    // Same rows, wider window — proves the emptiness above is the date filter
    // and not the bucketing quietly rejecting the fixture.
    expect(findSameAccountReversalCandidates("2026-06-01", handle.db)).toHaveLength(1);
  });

  it("excludes rows that are already paired", () => {
    const savings = seedAccount({ name: "Savings" });
    const batch = seedBatch("csv");
    const out = seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: -25000, rawMemo: "OUT", date: "2026-09-01" });
    const back = seedTxn({ accountId: savings.id, batchId: batch.id, amountCents: 25000, rawMemo: "REVERSE", date: "2026-09-01" });

    expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toHaveLength(1);
    linkTransferPairManually(out.id, back.id, handle.db, { allowSameAccountReversal: true });
    // Resolving it is what makes it leave the queue — otherwise the user is
    // asked the same question forever and cannot tell which ones they answered.
    expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toEqual([]);
  });

  it("excludes hand-entered rows (NOT_MANUAL) — a manual card charge has no bank reversal", () => {
    const card = seedAccount({ name: "Visa", type: "credit" });
    const manual = seedBatch("manual");
    seedTxn({ accountId: card.id, batchId: manual.id, amountCents: -25000, rawMemo: "HAND ENTERED", date: "2026-09-01", source: "manual" });
    seedTxn({ accountId: card.id, batchId: manual.id, amountCents: 25000, rawMemo: "HAND ENTERED CREDIT", date: "2026-09-01", source: "manual" });

    expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toEqual([]);
  });

  it("stops resurfacing a bucket the user rejected, end to end through the stored marker", () => {
    // The promise the queue makes is that "no" is durable. sameAccountReversals
    // proves the predicate honours a rejection; this proves the rejection
    // unlinkTransferPair actually WRITES is the one the query reads back.
    const checking = seedAccount({ name: "Checking" });
    const batch = seedBatch("csv");
    const charge = seedTxn({ accountId: checking.id, batchId: batch.id, amountCents: -1175, rawMemo: "AMAZON MKTPL*5Q7K15", date: "2026-09-03" });
    const refund = seedTxn({ accountId: checking.id, batchId: batch.id, amountCents: 1175, rawMemo: "AMAZON MKTPLACE PMT", date: "2026-09-03" });

    expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toHaveLength(1);

    linkTransferPairManually(charge.id, refund.id, handle.db, { allowSameAccountReversal: true });
    unlinkTransferPair(charge.id, handle.db);

    // Unpaired again, but rejected — so it must NOT come back asking.
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
    expect(findSameAccountReversalCandidates("2026-08-01", handle.db)).toEqual([]);
  });

  it("keeps a bucket alive when a THIRD candidate is still unrejected", () => {
    // Rejecting one pairing is not a statement about the others: the live
    // 2026-09-04 cluster has one positive against several negatives.
    const checking = seedAccount({ name: "Checking" });
    const batch = seedBatch("csv");
    const credit = seedTxn({ accountId: checking.id, batchId: batch.id, amountCents: 1000, rawMemo: "A2AXFER Ref# BFA33 reverse", date: "2026-09-04" });
    const debitA = seedTxn({ accountId: checking.id, batchId: batch.id, amountCents: -1000, rawMemo: "A2AXFER Ref# 0AA08", date: "2026-09-04" });
    const debitB = seedTxn({ accountId: checking.id, batchId: batch.id, amountCents: -1000, rawMemo: "Zelle Transfer Payment ID", date: "2026-09-04" });

    linkTransferPairManually(credit.id, debitB.id, handle.db, { allowSameAccountReversal: true });
    unlinkTransferPair(credit.id, handle.db);

    const buckets = findSameAccountReversalCandidates("2026-08-01", handle.db);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].negatives.map((r) => r.id).sort()).toEqual([debitA.id, debitB.id].sort());
  });
});
