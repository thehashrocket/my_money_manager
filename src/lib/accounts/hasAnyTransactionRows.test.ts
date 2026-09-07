import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { schema } from "@/db";
import { hasAnyTransactionRows } from "./hasAnyTransactionRows";

let handle: TestDbHandle;

function makeAccount(name: string, startingBalanceDate: string): number {
  const row = handle.db
    .insert(schema.accounts)
    .values({
      name,
      type: "credit",
      startingBalanceCents: -214800,
      startingBalanceDate,
    })
    .returning({ id: schema.accounts.id })
    .get();
  return row.id;
}

function makeBatch(): number {
  const row = handle.db
    .insert(schema.importBatches)
    .values({ source: "manual", transactionCount: 1 })
    .returning({ id: schema.importBatches.id })
    .get();
  return row.id;
}

function makeRow(accountId: number, date: string, hash: string) {
  handle.db
    .insert(schema.transactions)
    .values({
      accountId,
      date,
      rawDescription: "PURCHASE",
      rawMemo: "COSTCO",
      normalizedMerchant: "costco",
      amountCents: -8000,
      importSource: "manual",
      importBatchId: makeBatch(),
      importRowHash: hash,
    })
    .run();
}

beforeEach(() => {
  handle = createTestDb();
});
afterEach(() => handle.close());

describe("hasAnyTransactionRows", () => {
  it("is false for an account with no rows — the mortgage under D3=A", () => {
    const id = makeAccount("Mortgage", "2026-09-06");
    expect(hasAnyTransactionRows(id, handle.db)).toBe(false);
  });

  it("is true once the account owns a row", () => {
    const id = makeAccount("Visa", "2026-08-01");
    makeRow(id, "2026-08-15", "h1");
    expect(hasAnyTransactionRows(id, handle.db)).toBe(true);
  });

  it("stays true for a card reconciled to today, whose rows now ALL predate its anchor (E16)", () => {
    // The exact bug the cheap reading allows. loadAccountBalances' existing
    // aggregate is filtered `date > starting_balance_date`, so counting there
    // would report zero here — the card would look zero-row, become eligible
    // for a feed balance refresh, and break D15's "the SUM is zero regardless"
    // safety argument, which only holds with no rows to drop.
    const id = makeAccount("Visa", "2026-08-01");
    makeRow(id, "2026-08-10", "h1");
    makeRow(id, "2026-08-20", "h2");

    handle.db
      .update(schema.accounts)
      .set({ startingBalanceDate: "2026-09-06", startingBalanceCents: -300000 })
      .run();

    expect(hasAnyTransactionRows(id, handle.db)).toBe(true);
  });

  it("counts a row dated exactly on the anchor, which the strict `>` excludes", () => {
    const id = makeAccount("Visa", "2026-09-06");
    makeRow(id, "2026-09-06", "h1");
    expect(hasAnyTransactionRows(id, handle.db)).toBe(true);
  });

  it("is scoped per account", () => {
    const visa = makeAccount("Visa", "2026-08-01");
    const mortgage = makeAccount("Mortgage", "2026-08-01");
    makeRow(visa, "2026-08-15", "h1");
    expect(hasAnyTransactionRows(visa, handle.db)).toBe(true);
    expect(hasAnyTransactionRows(mortgage, handle.db)).toBe(false);
  });
});
