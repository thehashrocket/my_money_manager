import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadMerchantGroups } from "./loadMerchantGroups";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedAccount() {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: `Checking-${seq++}`,
      type: "checking",
      startingBalanceCents: 0,
      startingBalanceDate: "2026-01-01",
    })
    .returning()
    .all();
  return row;
}

function seedBatch() {
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", filename: "seed.csv" })
    .returning()
    .all();
  return row;
}

function seedCategory(name: string) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-${seq}` })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  merchant: string;
  amountCents: number;
  categoryId?: number | null;
  transferPairId?: number | null;
  date?: string;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-04-05",
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant,
      amountCents: opts.amountCents,
      categoryId: opts.categoryId ?? null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: opts.transferPairId ?? null,
      isPending: false,
    })
    .returning()
    .all();
  return row;
}

describe("loadMerchantGroups", () => {
  it("returns [] when no uncategorized rows exist", () => {
    expect(loadMerchantGroups(handle.db)).toEqual([]);
  });

  it("groups uncategorized rows by normalized_merchant with count + total", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -2500 });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "TRADER JOES", amountCents: -4000 });

    const groups = loadMerchantGroups(handle.db);
    expect(groups).toHaveLength(2);
    const safeway = groups.find((g) => g.normalizedMerchant === "SAFEWAY");
    expect(safeway?.count).toBe(2);
    expect(safeway?.totalCents).toBe(-7500);
    const tj = groups.find((g) => g.normalizedMerchant === "TRADER JOES");
    expect(tj?.count).toBe(1);
    expect(tj?.totalCents).toBe(-4000);
  });

  it("excludes already-categorized rows", () => {
    const a = seedAccount();
    const b = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -2500,
      categoryId: cat.id,
    });

    const groups = loadMerchantGroups(handle.db);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(1);
    expect(groups[0].totalCents).toBe(-5000);
  });

  it("excludes transfer-paired rows", () => {
    const a = seedAccount();
    const b = seedBatch();
    const paired = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "OVERDRAFT XFER",
      amountCents: -3000,
    });
    // Self-pair for test ergonomics; only the non-null transferPairId matters.
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .run();

    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    const groups = loadMerchantGroups(handle.db);
    expect(groups.map((g) => g.normalizedMerchant)).toEqual(["SAFEWAY"]);
  });

  it("sorts by count DESC, then merchant ASC", () => {
    const a = seedAccount();
    const b = seedBatch();
    for (let i = 0; i < 3; i++)
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "Z-BIG", amountCents: -100 });
    for (let i = 0; i < 1; i++)
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "A-SMALL", amountCents: -100 });
    for (let i = 0; i < 1; i++)
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "B-SMALL", amountCents: -100 });

    const groups = loadMerchantGroups(handle.db);
    expect(groups.map((g) => g.normalizedMerchant)).toEqual([
      "Z-BIG",
      "A-SMALL",
      "B-SMALL",
    ]);
  });

  it("surfaces an existing exact rule as existingRule", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: groceries.id,
        matchType: "exact",
        matchValue: "SAFEWAY",
        priority: 50,
        source: "manual",
      })
      .run();

    const groups = loadMerchantGroups(handle.db);
    expect(groups[0].existingRule).toEqual({
      categoryId: groceries.id,
      categoryName: groceries.name,
    });
  });

  it("ignores contains/regex rules when attaching existingRule", () => {
    const a = seedAccount();
    const b = seedBatch();
    const dining = seedCategory("Dining");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "contains",
        matchValue: "SAFE",
        priority: 50,
        source: "auto",
      })
      .run();

    expect(loadMerchantGroups(handle.db)[0].existingRule).toBeNull();
  });

  it("leaves existingRule null when no exact rule matches the merchant", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -5000 });

    expect(loadMerchantGroups(handle.db)[0].existingRule).toBeNull();
  });
});
