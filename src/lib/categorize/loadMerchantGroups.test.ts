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
    .values({ source: "csv", label: "seed.csv" })
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
  rawMemo?: string;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-04-05",
      rawDescription: "DESC",
      rawMemo: opts.rawMemo ?? "MEMO",
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

/**
 * T7/D16 — the sample memos behind each row's disclosure, and the row count
 * its drilldown link promises.
 */
describe("loadMerchantGroups — sample memos", () => {
  it("returns up to three DISTINCT memos, ignoring how often each repeats", () => {
    const a = seedAccount();
    const b = seedBatch();
    for (const memo of [
      "AMAZON MKTPL*8Y21QW",
      "AMAZON MKTPL*8Y21QW",
      "AMZN Mktp US*RT4T9",
      "AMAZON.COM*2K91LM",
      "AMAZON DIGITAL*QQ2",
    ]) {
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -1000, rawMemo: memo });
    }

    const [group] = loadMerchantGroups(handle.db);
    expect(group.normalizedMerchant).toBe("AMAZON");
    expect(group.sampleMemos).toHaveLength(3);
    expect(new Set(group.sampleMemos).size).toBe(3);
    for (const memo of group.sampleMemos) expect(memo).toMatch(/AM/);
  });

  it("suppresses a memo identical to the key — the 9.8% of rows that would render their own first line twice", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AUDIBLE", amountCents: -1499, rawMemo: "AUDIBLE" });
    // Star One pads its memos; the comparison has to survive that (rule 3).
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AUDIBLE", amountCents: -1499, rawMemo: "  AUDIBLE  " });

    const [group] = loadMerchantGroups(handle.db);
    expect(group.normalizedMerchant).toBe("AUDIBLE");
    // Empty means the row renders NO disclosure control at all, rather than a
    // control that opens onto nothing.
    expect(group.sampleMemos).toEqual([]);
  });

  it("trims the memo it returns", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -1000, rawMemo: "   SAFEWAY #1234   " });
    const [group] = loadMerchantGroups(handle.db);
    expect(group.sampleMemos).toEqual(["SAFEWAY #1234"]);
  });

  it("samples only the group's own uncategorized rows", () => {
    const a = seedAccount();
    const b = seedBatch();
    const cat = seedCategory("Gas");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "FUELCO", amountCents: -1000, rawMemo: "FUELCO OIL 0000" });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "FUELCO",
      amountCents: -1000,
      categoryId: cat.id,
      rawMemo: "FUELCO SERVICE STN 0",
    });

    const [group] = loadMerchantGroups(handle.db);
    expect(group.sampleMemos).toEqual(["FUELCO OIL 0000"]);
  });
});

describe("loadMerchantGroups — totalRowCount", () => {
  it("counts every non-transfer row for the key, filed or not (D3)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO GAS", amountCents: -5000 });
    for (let i = 0; i < 49; i += 1) {
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "COSTCO GAS",
        amountCents: -5000,
        categoryId: gas.id,
      });
    }

    const [group] = loadMerchantGroups(handle.db);
    // The row's own figure is the backlog; the link promises the history.
    expect(group.count).toBe(1);
    expect(group.totalRowCount).toBe(50);
  });

  it("excludes transfer-paired rows, matching what /transactions shows by default", () => {
    const a = seedAccount();
    const b = seedBatch();
    const anchor = seedTxn({ accountId: a.id, batchId: b.id, merchant: "ZELLE", amountCents: -2500 });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "ZELLE",
      amountCents: 2500,
      transferPairId: anchor.id,
    });

    const [group] = loadMerchantGroups(handle.db);
    expect(group.count).toBe(1);
    expect(group.totalRowCount).toBe(1);
  });
});

describe("loadMerchantGroups — sample memo edges", () => {
  it("skips a blank or whitespace-only memo rather than disclosing an empty line", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "VENMO", amountCents: -500, rawMemo: "" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "VENMO", amountCents: -500, rawMemo: "   " });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "VENMO",
      amountCents: -500,
      rawMemo: "VENMO PAYMENT 7781",
    });

    const [group] = loadMerchantGroups(handle.db);
    expect(group.sampleMemos).toEqual(["VENMO PAYMENT 7781"]);
  });

  it("takes the first three in a deterministic order, not SQLite's scan order", () => {
    const a = seedAccount();
    const b = seedBatch();
    // Inserted deliberately out of order: the cap is applied in JS over an
    // ORDER BY, so which three survive must not depend on insertion order.
    for (const memo of ["ZED 4", "ALPHA 1", "MID 3", "BETA 2"]) {
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "KIOSK", amountCents: -100, rawMemo: memo });
    }
    const [group] = loadMerchantGroups(handle.db);
    expect(group.sampleMemos).toEqual(["ALPHA 1", "BETA 2", "MID 3"]);
  });

  it("does not sample a transfer-paired row's memo", () => {
    const a = seedAccount();
    const b = seedBatch();
    const anchor = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SWEEP",
      amountCents: -2500,
      rawMemo: "SWEEP OUT 001",
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SWEEP",
      amountCents: 2500,
      transferPairId: anchor.id,
      rawMemo: "SWEEP IN 002",
    });

    const [group] = loadMerchantGroups(handle.db);
    expect(group.sampleMemos).toEqual(["SWEEP OUT 001"]);
  });
});
