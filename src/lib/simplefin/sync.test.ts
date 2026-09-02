import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import type { SimpleFinResponse, SimpleFinTransaction } from "./types";
import { syncSimpleFin, linkTransferPairManually } from "./sync";

/**
 * Exercises the dedup and manual-pairing logic against a real :memory: schema.
 *
 * The credential reader, the HTTP client and the pre-write snapshot are the
 * three things `syncSimpleFin` reaches outside the database for, so all three
 * are stubbed: these tests need no network, no SIMPLEFIN_ACCESS_URL and no
 * data/money.db on disk.
 */
const { fetchAccountsMock, createSnapshotMock } = vi.hoisted(() => ({
  fetchAccountsMock: vi.fn(),
  createSnapshotMock: vi.fn(() => ({
    snapshotPath: "/tmp/money.db.pre-import-TEST",
    timestamp: "TEST",
    prunedPaths: [] as string[],
  })),
}));

vi.mock("./accessUrl", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accessUrl")>()),
  readAccessUrl: () => ({
    accountsEndpoint: "https://bridge.test/simplefin/accounts",
    authHeader: "Basic dGVzdDp0ZXN0",
    host: "bridge.test",
  }),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  fetchAccounts: fetchAccountsMock,
}));

vi.mock("../snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../snapshot")>()),
  createSnapshot: createSnapshotMock,
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
    .values({ source, filename: `${source}.seed` })
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
