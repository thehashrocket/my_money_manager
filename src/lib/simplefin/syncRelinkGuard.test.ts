import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import type { SimpleFinResponse, SimpleFinTransaction } from "./types";
import { syncSimpleFin } from "./sync";
import { undoSyncBatch } from "./undoSync";
import { mapTransaction } from "./mapTransaction";

/**
 * The consequences of `verifyStagedLinks` that sit OUTSIDE the write loop.
 *
 * `sync.test.ts`'s own "re-verifies the account link inside the write
 * transaction" block pins the guard's three inputs (repoint, unlink, delete)
 * and the two-account partial-drop. Everything here is a downstream fact that
 * block does not reach: the audit trail, the batch's undoability, whether the
 * dropped rows are recoverable on the next run, and the two ways the guard can
 * report a FALSE positive (a same-value UPDATE) or misattribute a drop (two
 * accounts converging on one feed id).
 *
 * Same stubs as `sync.test.ts` — the credential reader, the HTTP client and the
 * pre-write snapshot are the three things `syncSimpleFin` reaches outside the
 * database for, so all three are replaced and these tests need no network, no
 * SIMPLEFIN_ACCESS_URL and no data/money.db on disk.
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

type FeedAccount = {
  id: string;
  transactions: SimpleFinTransaction[];
  balance?: string;
  name?: string;
};

function feedAccount(a: FeedAccount) {
  return {
    id: a.id,
    name: a.name ?? "REGULAR SAVINGS",
    balance: a.balance ?? "0.00",
    "available-balance": a.balance ?? "0.00",
    "balance-date": SEP_1_NOON,
    transactions: a.transactions,
  };
}

/**
 * Drives the REAL race rather than simulating its outcome: the ledger mutation
 * runs INSIDE the mocked `fetchAccounts` and only then resolves, which is
 * exactly the window a concurrent `setAccountLink` commits in.
 */
function respondAfter(mutate: () => void, accounts: FeedAccount[]): void {
  fetchAccountsMock.mockImplementation(async () => {
    mutate();
    return { accounts: accounts.map(feedAccount) } satisfies SimpleFinResponse;
  });
}

function relink(accountId: number, to: string | null): void {
  handle.db
    .update(schema.accounts)
    .set({ simplefinAccountId: to })
    .where(eq(schema.accounts.id, accountId))
    .run();
}

function syncedOrThrow(outcome: Awaited<ReturnType<typeof syncSimpleFin>>) {
  if (outcome.status !== "synced") throw new Error(`expected synced, got ${outcome.status}`);
  return outcome;
}

/**
 * Every sentence `verifyStagedLinks` emits for a dropped account. Deliberately
 * the clause all three share rather than the verb: the drop reasons (repointed,
 * unlinked, deleted) carry DIFFERENT remedies, so they are different sentences
 * with different verbs and different tails, and a test keyed on one verb
 * silently stopped counting the unlink case the moment it got its own copy —
 * which is exactly what happened. The shared middle is the invariant: whatever
 * the reason, nothing was written and the sentence says so.
 */
const WAS_DROPPED = /while the sync was running, so its transactions were not imported/;

describe("verifyStagedLinks — the warning is not a false positive", () => {
  it("does not report a relink when the mid-sync UPDATE sets the SAME feed id", async () => {
    // `setAccountLink` re-saving the value it already holds is an ordinary
    // no-op re-save (it returns `linkChanged: false` for exactly this). The
    // guard compares VALUES, not "did a write touch this row", so a no-op
    // re-save must not cost the user a whole account's import.
    const account = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondAfter(() => relink(account.id, "ACT-1"), [
      { id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87")] },
    ]);

    const outcome = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    expect(outcome.insertedCount).toBe(1);
    expect(outcome.warnings.some((w) => WAS_DROPPED.test(w))).toBe(false);
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(1);
  });

  it("drops BOTH sides of a mid-sync feed-id SWAP rather than crediting the new holder", async () => {
    // `accounts.simplefin_account_id` is UNIQUE, so two accounts cannot
    // converge on one feed id — the reachable shape is a swap: Savings gives
    // ACT-2 up and Checking takes it, both within the round trip.
    //
    // This is the case a guard written against the RESPONSE rather than the
    // staged pair gets wrong. "Is ACT-2 still claimed by some account?" is
    // true at the end of the swap, so such a guard would write ACT-2's rows —
    // onto Savings, which no longer holds that feed. The check has to be per
    // (account, feedId) pair, and both pairs are stale here.
    const checking = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    const savings = seedAccount({ simplefinAccountId: "ACT-2", name: "Savings" });

    respondAfter(
      () => {
        relink(savings.id, null);
        relink(checking.id, "ACT-2");
      },
      [
        { id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87")] },
        { id: "ACT-2", transactions: [feedTxn("TRN-z", "-9.99")] },
      ],
    );

    const outcome = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    expect(outcome.insertedCount).toBe(0);
    expect(handle.db.select().from(schema.transactions).all()).toEqual([]);
    expect(outcome.warnings.filter((w) => WAS_DROPPED.test(w))).toHaveLength(2);
    expect(outcome.warnings.some((w) => w.includes("Checking"))).toBe(true);
    expect(outcome.warnings.some((w) => w.includes("Savings"))).toBe(true);
  });

  it("drops the moved account even when it is staged LAST", async () => {
    // The staged list is walked in order and `verified` is rebuilt from it, so
    // a guard that short-circuited on the first entry, or that mutated the
    // array while iterating, would only show up when the drop is not first.
    const steady = seedAccount({ simplefinAccountId: "ACT-9", name: "Savings" });
    const moved = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });

    respondAfter(() => relink(moved.id, "ACT-2"), [
      { id: "ACT-9", transactions: [feedTxn("TRN-z", "-9.99")] },
      { id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87")] },
    ]);

    const outcome = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    expect(outcome.insertedCount).toBe(1);
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(steady.id);
    expect(rows[0].externalId).toBe("TRN-z");
  });
});

describe("verifyStagedLinks — an emptied batch is still a well-formed batch", () => {
  it("reports one warning per dropped account when EVERY account moved", async () => {
    // `verifiedTotal === 0` with a non-empty staged list is the branch the
    // `up-to-date` early return cannot reach: the batch row is already
    // committed by the time the guard has run, so `synced` with nothing
    // written is a real state and each account has to say so for itself.
    const a = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    const b = seedAccount({ simplefinAccountId: "ACT-2", name: "Savings" });

    respondAfter(
      () => {
        relink(a.id, "ACT-8");
        relink(b.id, null);
      },
      [
        { id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87")] },
        { id: "ACT-2", transactions: [feedTxn("TRN-z", "-9.99")] },
      ],
    );

    const outcome = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    expect(outcome.insertedCount).toBe(0);
    expect(outcome.pairsLinked).toBe(0);
    expect(handle.db.select().from(schema.transactions).all()).toEqual([]);
    expect(outcome.warnings.filter((w) => WAS_DROPPED.test(w))).toHaveLength(2);
    expect(outcome.warnings.some((w) => w.includes("Checking"))).toBe(true);
    expect(outcome.warnings.some((w) => w.includes("Savings"))).toBe(true);

    const batches = handle.db.select().from(schema.importBatches).all();
    expect(batches).toHaveLength(1);
    expect(batches[0].transactionCount).toBe(0);
  });

  it("writes NO import_batch_categorizations for a dropped account, and still writes them for a kept one", async () => {
    // The categorization audit rows are written inside the same loop as the
    // transactions, so a dropped account must leave no provenance behind
    // either — `undoImportCategorization` reverts by joining these rows to
    // transactions, and an orphan here points at a row that does not exist.
    const moved = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    const steady = seedAccount({ simplefinAccountId: "ACT-9", name: "Savings" });
    const [category] = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Dining"))
      .all();
    if (!category) throw new Error('seed category "Dining" missing');

    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: category.id,
        matchType: "exact",
        matchValue: mapTransaction(feedTxn("TRN-a", "-4.87")).normalizedMerchant,
        source: "manual",
      })
      .run();

    respondAfter(() => relink(moved.id, "ACT-2"), [
      // Both rows carry the SAME memo, so both would match the rule. Only the
      // surviving account's may produce an audit row.
      { id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87")] },
      { id: "ACT-9", transactions: [feedTxn("TRN-z", "-9.99")] },
    ]);

    const outcome = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    const audit = handle.db.select().from(schema.importBatchCategorizations).all();
    expect(audit).toHaveLength(1);
    expect(audit[0].importBatchId).toBe(outcome.batchId);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(steady.id);
    expect(audit[0].transactionId).toBe(rows[0].id);
    expect(rows[0].categoryId).toBe(category.id);
  });

  it("leaves an emptied batch that undoSyncBatch can still clear", async () => {
    // `transactionCount` is set from `verifiedTotal` precisely so this batch
    // does not advertise rows it never wrote. The batch is real and is the
    // newest one, so it must remain undoable rather than becoming a permanent
    // resident that makes every later undo report `stale`.
    const account = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondAfter(() => relink(account.id, "ACT-2"), [
      { id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87")] },
    ]);

    const outcome = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    expect(undoSyncBatch(outcome.batchId, handle.db)).toEqual({
      status: "undone",
      batchId: outcome.batchId,
      deletedCount: 0,
    });
    expect(handle.db.select().from(schema.importBatches).all()).toEqual([]);
  });
});

describe("verifyStagedLinks — the dropped rows are withheld, never lost", () => {
  it("imports them on the NEXT sync, tagged with the link they were re-verified against", async () => {
    // The warning promises "sync again to import them against the current
    // link". Nothing was written for the account, so no dedup pass has a
    // record of the withheld rows — this is what makes that promise true
    // rather than merely reassuring.
    const account = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondAfter(() => relink(account.id, "ACT-2"), [
      { id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87")] },
    ]);

    const first = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));
    expect(first.insertedCount).toBe(0);

    // Second run: no relink this time, and the feed answers on the account's
    // CURRENT link. Same underlying transaction, new feed id.
    fetchAccountsMock.mockReset();
    fetchAccountsMock.mockResolvedValue({
      accounts: [feedAccount({ id: "ACT-2", transactions: [feedTxn("TRN-a", "-4.87")] })],
    } satisfies SimpleFinResponse);

    const second = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    expect(second.insertedCount).toBe(1);
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(account.id);
    expect(rows[0].externalId).toBe("TRN-a");
    // Provenance is the feed that actually produced the written row, which is
    // the RE-VERIFIED link — not the one staged during the first, dropped run.
    expect(rows[0].simplefinSourceAccountId).toBe("ACT-2");
  });

  it("does not leave a dedup ghost — the withheld row is not content-matched away next run", async () => {
    // The content-dedup pass counts existing rows as a budget. A dropped run
    // that had somehow left a partial row (or a batch claiming one) would
    // spend that budget and make the retry a silent no-op, which is the exact
    // failure mode "sync again" would then never recover from.
    const account = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondAfter(() => relink(account.id, "ACT-2"), [
      { id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87"), feedTxn("TRN-b", "-4.87")] },
    ]);

    syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    fetchAccountsMock.mockReset();
    fetchAccountsMock.mockResolvedValue({
      accounts: [
        feedAccount({
          id: "ACT-2",
          transactions: [feedTxn("TRN-a", "-4.87"), feedTxn("TRN-b", "-4.87")],
        }),
      ],
    } satisfies SimpleFinResponse);

    const second = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    // Two genuinely identical same-day rows: both survive, as they must.
    expect(second.insertedCount).toBe(2);
    expect(second.accounts[0].duplicateByContent).toBe(0);
    expect(second.accounts[0].duplicateByExternalId).toBe(0);
  });
});

describe("verifyStagedLinks — what the outcome still reports about a dropped account", () => {
  it("reports BOTH the guard's warning and finaliseBalances' own when the account was deleted", async () => {
    // Two different facts from two different passes: the write guard says the
    // rows were withheld, and the balance pass says the balance could not be
    // checked at all. Collapsing them would hide the second, which is the one
    // that explains a missing row on /sync's balance table.
    const account = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondAfter(
      () => handle.db.delete(schema.accounts).where(eq(schema.accounts.id, account.id)).run(),
      [{ id: "ACT-1", transactions: [feedTxn("TRN-a", "-4.87")] }],
    );

    const outcome = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    expect(outcome.warnings.some((w) => w.includes("deleted") && w.includes("Checking"))).toBe(
      true,
    );
    expect(outcome.warnings.some((w) => w.includes("disappeared") && w.includes("Checking"))).toBe(
      true,
    );
    // No summary can be computed for a row that is gone, so the account must
    // not appear with a fabricated 0 balance.
    expect(outcome.accounts).toEqual([]);
  });

  it("reports NO drift for a re-pointed account, because the old feed's balance is not a fact about it", async () => {
    // This test previously asserted a drift of 487 and called it "honest about
    // the ledger as it stands". It is not: `reportedBalanceCents` came from the
    // feed the account was staged against and no longer holds, so subtracting
    // it from the account's CURRENT ledger produces a number about two
    // different accounts. Rule 1 reads a non-zero drift as "a row is missing or
    // duplicated", so the old assertion pinned a manufactured version of the
    // app's own corruption signal.
    const account = seedAccount({ simplefinAccountId: "ACT-1", name: "Checking" });
    respondAfter(() => relink(account.id, "ACT-2"), [
      { id: "ACT-1", balance: "-4.87", transactions: [feedTxn("TRN-a", "-4.87")] },
    ]);

    const outcome = syncedOrThrow(await syncSimpleFin({ now: NOW }, handle.db));

    expect(outcome.accounts).toHaveLength(1);
    expect(outcome.accounts[0].accountId).toBe(account.id);
    expect(outcome.accounts[0].computedBalanceCents).toBe(0);
    // Nulled with the rest of the dropped account's record; `driftCents`
    // short-circuits to null on a null reported balance.
    expect(outcome.accounts[0].reportedBalanceCents).toBeNull();
    expect(outcome.accounts[0].driftCents).toBeNull();
    expect(outcome.accounts[0].insertedCount).toBe(0);
    expect(outcome.accounts[0].duplicateByExternalId).toBe(0);
  });
});
