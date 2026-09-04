import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadUncategorizedBacklog } from "./loadUncategorizedBacklog";

/**
 * TC27 (X4 + E5): moved here from loadMonthView.test.ts when
 * loadUncategorizedBacklog became its own module.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

function seedAccount() {
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
  return account;
}

function seedBatch() {
  const [batch] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", label: "seed.csv" })
    .returning()
    .all();
  return batch;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  date: string;
  amountCents: number;
  transferPairId?: number | null;
}) {
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "TEST",
      rawMemo: "",
      normalizedMerchant: "TEST",
      amountCents: opts.amountCents,
      categoryId: null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `${opts.date}-${opts.amountCents}-${Math.random()}`,
      transferPairId: opts.transferPairId ?? null,
    })
    .returning()
    .all();
  return row;
}

describe("loadUncategorizedBacklog (TC27)", () => {
  it("unscoped: counts uncategorized rows across all time, excluding transfer pairs", () => {
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-03-10", amountCents: -1200 });
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-01", amountCents: -2500 });
    const paired = seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-02", amountCents: -9999 });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    const backlog = loadUncategorizedBacklog(handle.db);
    expect(backlog.count).toBe(2);
    expect(backlog.totalCents).toBe(-3700);
  });

  it("scoped: counts only the given month's uncategorized rows", () => {
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-03-10", amountCents: -1200 });
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-01", amountCents: -2500 });
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-30", amountCents: -100 });
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-05-01", amountCents: -9999 });

    const backlog = loadUncategorizedBacklog(handle.db, { year: 2026, month: 4 });
    expect(backlog.count).toBe(2);
    expect(backlog.totalCents).toBe(-2600);
  });

  it("scoped and unscoped differ on a fixture spanning two months", () => {
    const account = seedAccount();
    const batch = seedBatch();
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-03-15", amountCents: -500 });
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-15", amountCents: -700 });

    const unscoped = loadUncategorizedBacklog(handle.db);
    const scoped = loadUncategorizedBacklog(handle.db, { year: 2026, month: 4 });

    expect(unscoped).toEqual({ count: 2, totalCents: -1200 });
    expect(scoped).toEqual({ count: 1, totalCents: -700 });
  });

  it("returns zeros when there are no uncategorized rows", () => {
    expect(loadUncategorizedBacklog(handle.db)).toEqual({ count: 0, totalCents: 0 });
    expect(loadUncategorizedBacklog(handle.db, { year: 2026, month: 4 })).toEqual({
      count: 0,
      totalCents: 0,
    });
  });

  it("scoped excludes transfer-paired rows too", () => {
    const account = seedAccount();
    const batch = seedBatch();
    const paired = seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-05", amountCents: -3000 });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();
    seedTxn({ accountId: account.id, batchId: batch.id, date: "2026-04-06", amountCents: -1500 });

    const scoped = loadUncategorizedBacklog(handle.db, { year: 2026, month: 4 });
    expect(scoped).toEqual({ count: 1, totalCents: -1500 });
  });
});
