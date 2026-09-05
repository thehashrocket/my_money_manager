import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { escapeLikePattern, loadTransactions } from "./loadTransactions";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedAccount(name = "Checking") {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: `${name}-${seq}`,
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
  merchant?: string;
  amountCents?: number;
  categoryId?: number | null;
  transferPairId?: number | null;
  date?: string;
  rawDescription?: string;
  payee?: string | null;
  isPending?: boolean;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-04-05",
      rawDescription: opts.rawDescription ?? "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant ?? "SAFEWAY",
      payee: opts.payee ?? null,
      amountCents: opts.amountCents ?? -1000,
      categoryId: opts.categoryId ?? null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: opts.transferPairId ?? null,
      isPending: opts.isPending ?? false,
    })
    .returning()
    .all();
  return row;
}

describe("loadTransactions", () => {
  it("returns empty result set when table is empty", () => {
    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    expect(r.rows).toEqual([]);
    expect(r.totalCount).toBe(0);
  });

  it("filters by exact categoryId", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: groceries.id });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: dining.id });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: null });

    const r = loadTransactions(handle.db, {
      categoryId: groceries.id,
      page: 1,
      pageSize: 50,
    });
    expect(r.totalCount).toBe(2);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.categoryId).toBe(groceries.id);
      expect(row.categoryName).toBe(groceries.name);
    }
  });

  it("filters categoryId='none' to NULL-category rows only", () => {
    const a = seedAccount();
    const b = seedBatch();
    const cat = seedCategory("X");
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: null });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: null });

    const r = loadTransactions(handle.db, {
      categoryId: "none",
      page: 1,
      pageSize: 50,
    });
    expect(r.totalCount).toBe(2);
    for (const row of r.rows) expect(row.categoryId).toBeNull();
  });

  it("filters by dateFrom/dateTo (inclusive on both ends)", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-03-31" });
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-04-01" });
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-04-30" });
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-05-01" });

    const r = loadTransactions(handle.db, {
      dateFrom: "2026-04-01",
      dateTo: "2026-04-30",
      page: 1,
      pageSize: 50,
    });
    expect(r.totalCount).toBe(2);
    expect(r.rows.map((row) => row.date).sort()).toEqual([
      "2026-04-01",
      "2026-04-30",
    ]);
  });

  it("handles a dateFrom/dateTo window spanning a December → January rollover", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-12-31" });
    seedTxn({ accountId: a.id, batchId: b.id, date: "2027-01-01" });

    const r = loadTransactions(handle.db, {
      dateFrom: "2026-12-01",
      dateTo: "2026-12-31",
      page: 1,
      pageSize: 50,
    });
    expect(r.totalCount).toBe(1);
    expect(r.rows[0].date).toBe("2026-12-31");
  });

  it("dateFrom alone is an open-ended upper bound", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-04-30" });
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-05-01" });

    const r = loadTransactions(handle.db, { dateFrom: "2026-05-01", page: 1, pageSize: 50 });
    expect(r.totalCount).toBe(1);
    expect(r.rows[0].date).toBe("2026-05-01");
  });

  it("dateTo alone is an open-ended lower bound", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-04-30" });
    seedTxn({ accountId: a.id, batchId: b.id, date: "2026-05-01" });

    const r = loadTransactions(handle.db, { dateTo: "2026-04-30", page: 1, pageSize: 50 });
    expect(r.totalCount).toBe(1);
    expect(r.rows[0].date).toBe("2026-04-30");
  });

  it("filters to one account", () => {
    const a = seedAccount("Checking");
    const b = seedAccount("Savings");
    const batch = seedBatch();
    seedTxn({ accountId: a.id, batchId: batch.id });
    seedTxn({ accountId: b.id, batchId: batch.id });

    const r = loadTransactions(handle.db, { accountId: a.id, page: 1, pageSize: 50 });
    expect(r.totalCount).toBe(1);
    expect(r.rows[0].accountId).toBe(a.id);
  });

  describe("amount-magnitude range (D7)", () => {
    it("matches both a withdrawal and a deposit of the same magnitude", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, amountCents: -7500 });
      seedTxn({ accountId: a.id, batchId: b.id, amountCents: 7500 });
      seedTxn({ accountId: a.id, batchId: b.id, amountCents: -100 });

      const r = loadTransactions(handle.db, {
        amountMinCents: 5000,
        amountMaxCents: 10000,
        page: 1,
        pageSize: 50,
      });
      expect(r.totalCount).toBe(2);
      expect(r.rows.map((row) => row.amountCents).sort()).toEqual([-7500, 7500]);
    });

    it("amountMinCents alone is an open-ended upper bound", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, amountCents: -100 });
      seedTxn({ accountId: a.id, batchId: b.id, amountCents: -20000 });

      const r = loadTransactions(handle.db, { amountMinCents: 10000, page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
      expect(r.rows[0].amountCents).toBe(-20000);
    });

    it("amountMaxCents alone is an open-ended lower bound", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, amountCents: -100 });
      seedTxn({ accountId: a.id, batchId: b.id, amountCents: -20000 });

      const r = loadTransactions(handle.db, { amountMaxCents: 10000, page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
      expect(r.rows[0].amountCents).toBe(-100);
    });
  });

  describe("isPending tri-state", () => {
    it("unset applies no predicate (today's default: pending and posted both show)", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, isPending: false });
      seedTxn({ accountId: a.id, batchId: b.id, isPending: true });

      const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(2);
    });

    it("isPending=false returns posted rows only", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, isPending: false });
      seedTxn({ accountId: a.id, batchId: b.id, isPending: true });

      const r = loadTransactions(handle.db, { isPending: false, page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
      expect(r.rows[0].isPending).toBe(false);
    });

    it("isPending=true returns pending rows only", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, isPending: false });
      seedTxn({ accountId: a.id, batchId: b.id, isPending: true });

      const r = loadTransactions(handle.db, { isPending: true, page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
      expect(r.rows[0].isPending).toBe(true);
    });
  });

  describe("search", () => {
    it("matches on rawDescription", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "AMAZON MKTPLACE" });
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "OTHER" });

      const r = loadTransactions(handle.db, { search: "amazon", page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
    });

    it("matches on normalizedMerchant only (not rawDescription)", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "X", merchant: "TARGET" });
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "Y", merchant: "SAFEWAY" });

      const r = loadTransactions(handle.db, { search: "target", page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
      expect(r.rows[0].normalizedMerchant).toBe("TARGET");
    });

    it("matches on payee only", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "X", merchant: "Y", payee: "Costco Wholesale" });
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "X2", merchant: "Y2", payee: null });

      const r = loadTransactions(handle.db, { search: "costco", page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
    });

    it("matches a literal % without treating it as a wildcard", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "50% OFF SALE" });
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "SOMETHING ELSE" });

      const r = loadTransactions(handle.db, { search: "50%", page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
    });

    it("matches a literal _ without treating it as a single-char wildcard", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "ACCT_1234" });
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "ACCTX1234" });

      const r = loadTransactions(handle.db, { search: "ACCT_1234", page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
      expect(r.rows[0].rawDescription).toBe("ACCT_1234");
    });

    it("empty/whitespace-only search applies no predicate", () => {
      const a = seedAccount();
      const b = seedBatch();
      seedTxn({ accountId: a.id, batchId: b.id });
      seedTxn({ accountId: a.id, batchId: b.id });

      const r = loadTransactions(handle.db, { search: "   ", page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(2);
    });

    it("composes with other filters (AND, not OR)", () => {
      const a = seedAccount();
      const b = seedBatch();
      const groceries = seedCategory("Groceries");
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        rawDescription: "AMAZON",
        categoryId: groceries.id,
      });
      seedTxn({ accountId: a.id, batchId: b.id, rawDescription: "AMAZON", categoryId: null });

      const r = loadTransactions(handle.db, {
        search: "amazon",
        categoryId: groceries.id,
        page: 1,
        pageSize: 50,
      });
      expect(r.totalCount).toBe(1);
      expect(r.rows[0].categoryId).toBe(groceries.id);
    });
  });

  it("excludes transfer-paired rows", () => {
    const a = seedAccount();
    const b = seedBatch();
    const paired = seedTxn({ accountId: a.id, batchId: b.id });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: paired.id })
      .run();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    expect(r.totalCount).toBe(1);
    expect(r.rows[0].normalizedMerchant).toBe("SAFEWAY");
  });

  it("paginates with page/pageSize (offset = (page-1)*pageSize)", () => {
    const a = seedAccount();
    const b = seedBatch();
    for (let i = 0; i < 5; i++) {
      seedTxn({ accountId: a.id, batchId: b.id, date: `2026-04-0${i + 1}` });
    }

    const page1 = loadTransactions(handle.db, { page: 1, pageSize: 2 });
    expect(page1.totalCount).toBe(5);
    expect(page1.rows).toHaveLength(2);
    expect(page1.rows[0].date).toBe("2026-04-05");
    expect(page1.rows[1].date).toBe("2026-04-04");

    const page2 = loadTransactions(handle.db, { page: 2, pageSize: 2 });
    expect(page2.rows.map((r) => r.date)).toEqual(["2026-04-03", "2026-04-02"]);

    const page3 = loadTransactions(handle.db, { page: 3, pageSize: 2 });
    expect(page3.rows.map((r) => r.date)).toEqual(["2026-04-01"]);
  });

  it("sorts by date DESC, id DESC (stable tiebreak)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const first = seedTxn({ accountId: a.id, batchId: b.id, date: "2026-04-05" });
    const second = seedTxn({ accountId: a.id, batchId: b.id, date: "2026-04-05" });
    const third = seedTxn({ accountId: a.id, batchId: b.id, date: "2026-04-05" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    expect(r.rows.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
  });

  it("joins category and account names", () => {
    const a = seedAccount("MyBank");
    const accountName = a.name;
    const b = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id });

    const [row] = loadTransactions(handle.db, { page: 1, pageSize: 50 }).rows;
    expect(row.accountName).toBe(accountName);
    expect(row.categoryName).toBe(cat.name);
  });

  it("returns null categoryName when transaction has no category", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: null });

    const [row] = loadTransactions(handle.db, { page: 1, pageSize: 50 }).rows;
    expect(row.categoryId).toBeNull();
    expect(row.categoryName).toBeNull();
  });
});

describe("escapeLikePattern", () => {
  it("leaves a plain term unchanged", () => {
    expect(escapeLikePattern("amazon")).toBe("amazon");
  });

  it("escapes %", () => {
    expect(escapeLikePattern("50% off")).toBe("50\\% off");
  });

  it("escapes _", () => {
    expect(escapeLikePattern("acct_1234")).toBe("acct\\_1234");
  });

  it("escapes a literal backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });
});
