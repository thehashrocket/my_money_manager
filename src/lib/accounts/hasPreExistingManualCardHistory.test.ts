import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { schema } from "@/db";
import { hasPreExistingManualCardHistory } from "./hasPreExistingManualCardHistory";

let handle: TestDbHandle;

function makeAccount(startingBalanceDate: string): number {
  const row = handle.db
    .insert(schema.accounts)
    .values({
      name: "Citi",
      type: "credit",
      startingBalanceCents: -214800,
      startingBalanceDate,
    })
    .returning({ id: schema.accounts.id })
    .get();
  return row.id;
}

function makeBatch(source: "csv" | "simplefin" | "manual"): number {
  const row = handle.db
    .insert(schema.importBatches)
    .values({ source, transactionCount: 1 })
    .returning({ id: schema.importBatches.id })
    .get();
  return row.id;
}

function makeRow(opts: {
  accountId: number;
  date: string;
  source: "csv" | "simplefin" | "manual";
  hash: string;
}) {
  handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "PURCHASE",
      rawMemo: "COSTCO",
      normalizedMerchant: "costco",
      amountCents: -8000,
      importSource: opts.source,
      importBatchId: makeBatch(opts.source),
      importRowHash: opts.hash,
    })
    .run();
}

beforeEach(() => {
  handle = createTestDb();
});
afterEach(() => handle.close());

describe("hasPreExistingManualCardHistory", () => {
  it("is false for a card with no rows at all", () => {
    const id = makeAccount("2026-08-01");
    expect(hasPreExistingManualCardHistory(id, handle.db)).toBe(false);
  });

  it("is true for a manual row dated AFTER the anchor", () => {
    const id = makeAccount("2026-08-01");
    makeRow({ accountId: id, date: "2026-08-15", source: "manual", hash: "h1" });
    expect(hasPreExistingManualCardHistory(id, handle.db)).toBe(true);
  });

  /**
   * NOT scoped to the anchor, deliberately — see the function's own
   * docstring. A manual row on or before the anchor is just as capable of
   * colliding with a late-settling bank duplicate as one after it, because
   * the bank's OWN posted date (not the account's anchor) decides whether
   * the collision reaches the ledger. `/ship`'s adversarial review found a
   * live repro of exactly this: reconciling the anchor past a manual row's
   * date did not stop the bank's later-settling duplicate from importing.
   */
  it("is true for a manual row dated ON the anchor — the anchor is not a safe boundary here", () => {
    const id = makeAccount("2026-08-01");
    makeRow({ accountId: id, date: "2026-08-01", source: "manual", hash: "h1" });
    expect(hasPreExistingManualCardHistory(id, handle.db)).toBe(true);
  });

  it("is true for a manual row dated BEFORE the anchor", () => {
    const id = makeAccount("2026-08-01");
    makeRow({ accountId: id, date: "2026-07-01", source: "manual", hash: "h1" });
    expect(hasPreExistingManualCardHistory(id, handle.db)).toBe(true);
  });

  it("ignores a CSV or SimpleFIN row — only MANUAL provenance counts", () => {
    const id = makeAccount("2026-08-01");
    makeRow({ accountId: id, date: "2026-08-15", source: "csv", hash: "h1" });
    makeRow({ accountId: id, date: "2026-08-16", source: "simplefin", hash: "h2" });
    expect(hasPreExistingManualCardHistory(id, handle.db)).toBe(false);
  });

  it("is scoped to the account — a manual row on a DIFFERENT card does not block this one", () => {
    const id = makeAccount("2026-08-01");
    const other = makeAccount("2026-08-01");
    makeRow({ accountId: other, date: "2026-08-15", source: "manual", hash: "h1" });
    expect(hasPreExistingManualCardHistory(id, handle.db)).toBe(false);
  });
});
