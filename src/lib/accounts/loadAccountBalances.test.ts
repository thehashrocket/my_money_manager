import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadAccountBalances } from "./loadAccountBalances";

/**
 * `loadAccountBalances` had no direct test coverage before this file. The
 * diff that added `ledgerAsOfDate` (a MAX(date) over the same filtered set
 * as the SUM) touches the query every caller already depends on for
 * `balanceCents`, so both the pre-existing balance rule and the new field
 * are covered here together.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedAccount(opts: {
  startingBalanceCents: number;
  startingBalanceDate: string;
  name?: string;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: opts.name ?? `Account-${seq}`,
      type: "checking",
      startingBalanceCents: opts.startingBalanceCents,
      startingBalanceDate: opts.startingBalanceDate,
    })
    .returning()
    .all();
  return row;
}

function seedBatch() {
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", label: "seed.csv" })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  date: string;
  amountCents: number;
  isPending?: boolean;
}) {
  seq += 1;
  handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: "MERCHANT",
      amountCents: opts.amountCents,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      isPending: opts.isPending ?? false,
    })
    .run();
}

describe("loadAccountBalances", () => {
  it("sums posted rows dated after the anchor, and reports the newest as ledgerAsOfDate", () => {
    const account = seedAccount({
      startingBalanceCents: 100_000,
      startingBalanceDate: "2026-04-16",
    });
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-17", amountCents: -5210 });
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-18", amountCents: 120_000 });

    const [balance] = loadAccountBalances(handle.db);
    expect(balance.balanceCents).toBe(100_000 - 5210 + 120_000);
    expect(balance.ledgerAsOfDate).toBe("2026-04-18");
    expect(balance.startingBalanceDate).toBe("2026-04-16");
  });

  it("falls back to the anchor date as ledgerAsOfDate when no rows follow it", () => {
    seedAccount({ startingBalanceCents: 50_000, startingBalanceDate: "2026-04-16" });

    const [balance] = loadAccountBalances(handle.db);
    expect(balance.balanceCents).toBe(50_000);
    expect(balance.ledgerAsOfDate).toBe("2026-04-16");
  });

  it("excludes a row dated on or before the anchor (strict >)", () => {
    const account = seedAccount({
      startingBalanceCents: 100_000,
      startingBalanceDate: "2026-04-16",
    });
    const batch = seedBatch();
    // Same-day row: already folded into the anchor's closing balance.
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-16", amountCents: -999 });

    const [balance] = loadAccountBalances(handle.db);
    expect(balance.balanceCents).toBe(100_000);
    expect(balance.ledgerAsOfDate).toBe("2026-04-16");
  });

  it("excludes pending rows from both the sum and ledgerAsOfDate", () => {
    const account = seedAccount({
      startingBalanceCents: 100_000,
      startingBalanceDate: "2026-04-16",
    });
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-17", amountCents: -1000 });
    // Pending row is newer than the last posted row, and would move both
    // balanceCents and ledgerAsOfDate if the filter leaked it in.
    seedTxn({
      accountId: account.id,
      batchId: batch.id,
      date: "2026-04-19",
      amountCents: -50_000,
      isPending: true,
    });

    const [balance] = loadAccountBalances(handle.db);
    expect(balance.balanceCents).toBe(100_000 - 1000);
    expect(balance.ledgerAsOfDate).toBe("2026-04-17");
  });

  it("computes each account's balance independently", () => {
    const a = seedAccount({
      startingBalanceCents: 100_000,
      startingBalanceDate: "2026-04-16",
      name: "Checking",
    });
    const b = seedAccount({
      startingBalanceCents: 5_000,
      startingBalanceDate: "2026-04-16",
      name: "Savings",
    });
    const batch = seedBatch();
    seedTxn({ accountId: a.id, batchId: batch.id, date: "2026-04-17", amountCents: -2000 });
    seedTxn({ accountId: b.id, batchId: batch.id, date: "2026-04-20", amountCents: 10_000 });

    const balances = loadAccountBalances(handle.db);
    const byId = new Map(balances.map((x) => [x.id, x]));
    expect(byId.get(a.id)?.balanceCents).toBe(98_000);
    expect(byId.get(a.id)?.ledgerAsOfDate).toBe("2026-04-17");
    expect(byId.get(b.id)?.balanceCents).toBe(15_000);
    expect(byId.get(b.id)?.ledgerAsOfDate).toBe("2026-04-20");
  });
});
