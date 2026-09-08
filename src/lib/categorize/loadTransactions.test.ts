import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { escapeLikePattern, loadTransactions, summarizeByCategory } from "./loadTransactions";

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

/**
 * E9/T12 — `includeTransfers`, the data half. T26 owns every pixel of the UI.
 *
 * The predicate had two states and one of them had never been exercised: for
 * the whole life of this function, paired rows were unconditionally hidden.
 */
describe("loadTransactions — includeTransfers (D14=B)", () => {
  function seedPair() {
    const checking = seedAccount("Checking");
    const visa = seedAccount("Visa");
    const batch = seedBatch();
    const leg = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      merchant: "PAYMENT TO VISA",
      amountCents: -50_000,
    });
    const mirror = seedTxn({
      accountId: visa.id,
      batchId: batch.id,
      merchant: "PAYMENT FROM CHECKING",
      amountCents: 50_000,
    });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: mirror.id })
      .where(eq(schema.transactions.id, leg.id))
      .run();
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: leg.id })
      .where(eq(schema.transactions.id, mirror.id))
      .run();
    const ordinary = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      merchant: "COSTCO",
      amountCents: -8_000,
    });
    return { leg, mirror, ordinary, checking, visa };
  }

  const base = { page: 1, pageSize: 50 };

  it("excludes paired rows by default — unchanged behaviour", () => {
    const { ordinary } = seedPair();
    const result = loadTransactions(handle.db, base);
    expect(result.rows.map((r) => r.id)).toEqual([ordinary.id]);
    expect(result.totalCount).toBe(1);
  });

  it("excludes them when explicitly false", () => {
    seedPair();
    expect(loadTransactions(handle.db, { ...base, includeTransfers: false }).totalCount).toBe(1);
  });

  it("includes both legs when true", () => {
    // Without this, marking a checking debit as a card payment makes the row
    // vanish from the page you use to manage transactions.
    const { leg, mirror, ordinary } = seedPair();
    const result = loadTransactions(handle.db, { ...base, includeTransfers: true });
    expect(result.totalCount).toBe(3);
    expect(new Set(result.rows.map((r) => r.id))).toEqual(
      new Set([leg.id, mirror.id, ordinary.id]),
    );
  });

  it("names the partner account on a revealed row, and leaves it null otherwise", () => {
    // A revealed row without its partner is just a transaction that
    // mysteriously does not count toward anything.
    const { leg, mirror, ordinary, checking, visa } = seedPair();
    const rows = loadTransactions(handle.db, { ...base, includeTransfers: true }).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId[leg.id].transferPairId).toBe(mirror.id);
    expect(byId[leg.id].transferPartnerAccountName).toBe(visa.name);
    expect(byId[mirror.id].transferPartnerAccountName).toBe(checking.name);
    expect(byId[ordinary.id].transferPairId).toBeNull();
    expect(byId[ordinary.id].transferPartnerAccountName).toBeNull();
  });

  it("composes with the other filters rather than overriding them", () => {
    const { visa } = seedPair();
    const result = loadTransactions(handle.db, {
      ...base,
      includeTransfers: true,
      accountId: visa.id,
    });
    expect(result.totalCount).toBe(1);
    expect(result.rows[0].accountName).toBe(visa.name);
  });

  it("counts and pages over the same set it returns", () => {
    seedPair();
    const page1 = loadTransactions(handle.db, {
      page: 1,
      pageSize: 2,
      includeTransfers: true,
    });
    expect(page1.totalCount).toBe(3);
    expect(page1.rows).toHaveLength(2);
    const page2 = loadTransactions(handle.db, {
      page: 2,
      pageSize: 2,
      includeTransfers: true,
    });
    expect(page2.rows).toHaveLength(1);
  });
});

/**
 * D2 — the drilldown's filter is EXACT, and this is the assertion that stops
 * anyone from "simplifying" it back into the existing `search` predicate.
 *
 * `search` is `LIKE %x%` across three columns. On the real ledger that turns
 * 11 of 191 merchant groups into supersets — clicking `AMAZON` (53 rows)
 * would land on 71, silently including `AMAZON PRIME`, which is a different
 * merchant filed to a different category.
 */
describe("loadTransactions — merchant filter (D2)", () => {
  it("matches the key exactly and does NOT match a longer key sharing its prefix", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON PRIME" });

    const exact = loadTransactions(handle.db, { merchant: "AMAZON", page: 1, pageSize: 50 });
    expect(exact.totalCount).toBe(2);
    for (const row of exact.rows) expect(row.normalizedMerchant).toBe("AMAZON");

    // The same term through `search` is the superset this decision rejected.
    const viaSearch = loadTransactions(handle.db, { search: "AMAZON", page: 1, pageSize: 50 });
    expect(viaSearch.totalCount).toBe(3);
  });

  it("matches URL-hostile keys literally — no wildcard, no escaping surface", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ARCO#05450AMERI" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "CA DMV 658 *SVC" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "PG E/EZ-PAY" });

    for (const key of ["ARCO#05450AMERI", "CA DMV 658 *SVC", "PG E/EZ-PAY"]) {
      const r = loadTransactions(handle.db, { merchant: key, page: 1, pageSize: 50 });
      expect(r.totalCount).toBe(1);
      expect(r.rows[0].normalizedMerchant).toBe(key);
    }
  });

  it("composes with categoryId, accountId and the date window", () => {
    const checking = seedAccount("Checking");
    const savings = seedAccount("Savings");
    const b = seedBatch();
    const gas = seedCategory("Gas");
    seedTxn({ accountId: checking.id, batchId: b.id, merchant: "COSTCO GAS", categoryId: gas.id, date: "2026-04-10" });
    seedTxn({ accountId: checking.id, batchId: b.id, merchant: "COSTCO GAS", categoryId: null, date: "2026-04-10" });
    seedTxn({ accountId: checking.id, batchId: b.id, merchant: "COSTCO GAS", categoryId: gas.id, date: "2026-05-10" });
    seedTxn({ accountId: savings.id, batchId: b.id, merchant: "COSTCO GAS", categoryId: gas.id, date: "2026-04-10" });

    expect(
      loadTransactions(handle.db, { merchant: "COSTCO GAS", page: 1, pageSize: 50 }).totalCount,
    ).toBe(4);
    expect(
      loadTransactions(handle.db, {
        merchant: "COSTCO GAS",
        categoryId: gas.id,
        page: 1,
        pageSize: 50,
      }).totalCount,
    ).toBe(3);
    expect(
      loadTransactions(handle.db, {
        merchant: "COSTCO GAS",
        accountId: checking.id,
        dateFrom: "2026-04-01",
        dateTo: "2026-04-30",
        page: 1,
        pageSize: 50,
      }).totalCount,
    ).toBe(2);
  });

  it("applies no predicate when undefined or empty", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    expect(loadTransactions(handle.db, { page: 1, pageSize: 50 }).totalCount).toBe(2);
    expect(
      loadTransactions(handle.db, { merchant: undefined, page: 1, pageSize: 50 }).totalCount,
    ).toBe(2);
    expect(loadTransactions(handle.db, { merchant: "", page: 1, pageSize: 50 }).totalCount).toBe(2);
  });

  it("a key no row carries returns zero rows, not every row", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON" });
    const r = loadTransactions(handle.db, { merchant: "amazon", page: 1, pageSize: 50 });
    expect(r.totalCount).toBe(0);
    expect(r.rows).toEqual([]);
  });

  it("totalCount is computed with the same predicate as the rows, across pages", () => {
    const a = seedAccount();
    const b = seedBatch();
    for (let i = 0; i < 5; i += 1) {
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", date: `2026-04-0${i + 1}` });
    }
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON PRIME" });

    const page1 = loadTransactions(handle.db, { merchant: "AMAZON", page: 1, pageSize: 2 });
    expect(page1.totalCount).toBe(5);
    expect(page1.rows).toHaveLength(2);
    const page3 = loadTransactions(handle.db, { merchant: "AMAZON", page: 3, pageSize: 2 });
    expect(page3.totalCount).toBe(5);
    expect(page3.rows).toHaveLength(1);
    for (const row of [...page1.rows, ...page3.rows]) {
      expect(row.normalizedMerchant).toBe("AMAZON");
    }
  });

  it("still excludes transfer-paired rows unless includeTransfers is set", () => {
    const a = seedAccount();
    const b = seedBatch();
    const plain = seedTxn({ accountId: a.id, batchId: b.id, merchant: "ZELLE" });
    const paired = seedTxn({ accountId: a.id, batchId: b.id, merchant: "ZELLE" });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: plain.id })
      .where(eq(schema.transactions.id, paired.id))
      .run();

    expect(
      loadTransactions(handle.db, { merchant: "ZELLE", page: 1, pageSize: 50 }).totalCount,
    ).toBe(1);
    expect(
      loadTransactions(handle.db, {
        merchant: "ZELLE",
        includeTransfers: true,
        page: 1,
        pageSize: 50,
      }).totalCount,
    ).toBe(2);
  });
});

/**
 * T9/D18 — the merchant header's `49 filed as Gas` line. It has to describe
 * the SAME row set as the list under it, which is why it shares
 * `buildPredicates` rather than rebuilding the WHERE clause.
 */
describe("summarizeByCategory", () => {
  it("groups the filtered rows by category, biggest group first, NULL included", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    for (let i = 0; i < 3; i += 1) {
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO GAS", categoryId: gas.id });
    }
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO GAS", categoryId: groceries.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO GAS", categoryId: null });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SOMETHING ELSE", categoryId: gas.id });

    const breakdown = summarizeByCategory(handle.db, { merchant: "COSTCO GAS" });
    expect(breakdown).toEqual([
      { categoryId: gas.id, categoryName: gas.name, count: 3 },
      { categoryId: groceries.id, categoryName: groceries.name, count: 1 },
      { categoryId: null, categoryName: null, count: 1 },
    ]);
  });

  it("its counts sum to the list's own totalCount for the same filter", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SHELL", categoryId: gas.id, date: "2026-04-02" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SHELL", categoryId: null, date: "2026-04-03" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SHELL", categoryId: null, date: "2026-05-03" });

    const filter = { merchant: "SHELL", dateFrom: "2026-04-01", dateTo: "2026-04-30" };
    const { totalCount } = loadTransactions(handle.db, { ...filter, page: 1, pageSize: 50 });
    const summed = summarizeByCategory(handle.db, filter).reduce((n, r) => n + r.count, 0);
    expect(summed).toBe(totalCount);
    expect(totalCount).toBe(2);
  });

  it("returns an empty array when nothing matches", () => {
    expect(summarizeByCategory(handle.db, { merchant: "NOTHING" })).toEqual([]);
  });
});

describe("summarizeByCategory — tie-breaking", () => {
  it("breaks an equal-count tie by category name, so the header is stable across runs", () => {
    const a = seedAccount();
    const b = seedBatch();
    const zed = seedCategory("Zed");
    const alpha = seedCategory("Alpha");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "TIE", categoryId: zed.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "TIE", categoryId: alpha.id });

    const breakdown = summarizeByCategory(handle.db, { merchant: "TIE" });
    expect(breakdown.map((r) => r.categoryName)).toEqual([alpha.name, zed.name]);
  });

  it("sorts Uncategorized last even when it is the biggest group, once tied", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "TIE", categoryId: null });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "TIE", categoryId: gas.id });

    const breakdown = summarizeByCategory(handle.db, { merchant: "TIE" });
    expect(breakdown.map((r) => r.categoryId)).toEqual([gas.id, null]);
  });
});
