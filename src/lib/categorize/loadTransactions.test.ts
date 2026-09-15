import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { createOrUpdateRule } from "@/lib/rules";
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
  importSource?: "csv" | "simplefin" | "manual";
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
      importSource: opts.importSource ?? "csv",
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

  it("pairIsAppCreated (D5.2) is false for an ordinary bank-to-bank transfer pair", () => {
    // seedPair()'s two legs are both `importSource: 'csv'` — a real transfer
    // the automatic matcher paired, not a mirror `markAsCardPayment` wrote.
    const { leg, mirror, ordinary } = seedPair();
    const rows = loadTransactions(handle.db, { ...base, includeTransfers: true }).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId[leg.id].pairIsAppCreated).toBe(false);
    expect(byId[mirror.id].pairIsAppCreated).toBe(false);
    expect(byId[ordinary.id].pairIsAppCreated).toBe(false);
  });

  it("pairIsAppCreated (D5.2) is true on BOTH legs of an app-created card-payment pair", () => {
    const checking = seedAccount("Checking");
    const visa = seedAccount("Visa");
    const batch = seedBatch();
    const leg = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      merchant: "PAYMENT TO VISA",
      amountCents: -50_000,
      categoryId: null,
    });
    // The synthetic mirror shape: manual + uncategorized.
    const mirror = seedTxn({
      accountId: visa.id,
      batchId: batch.id,
      merchant: "PAYMENT TO VISA",
      amountCents: 50_000,
      importSource: "manual",
      categoryId: null,
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

    const rows = loadTransactions(handle.db, { ...base, includeTransfers: true }).rows;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    // Reachable from EITHER end, matching `unmarkCardPayment`'s own
    // "works from either end" note — the row menu can be opened on the
    // checking leg or on the mirror itself.
    expect(byId[leg.id].pairIsAppCreated).toBe(true);
    expect(byId[mirror.id].pairIsAppCreated).toBe(true);
  });

  it("pairIsAppCreated (D5.2) degrades to false on a dangling transfer_pair_id, rather than guessing", () => {
    // `transferPairId` has `onDelete: 'set null'`, so a partner's deletion
    // through the ORM always clears this leg's pairing — a dangling pointer
    // should be unreachable in ordinary use. Forced here only to prove the
    // defensive branch degrades safely instead of crashing or mis-reading a
    // null partner as "not a mirror, so app-created" by accident.
    const checking = seedAccount("Checking");
    const batch = seedBatch();
    const leg = seedTxn({
      accountId: checking.id,
      batchId: batch.id,
      merchant: "PAYMENT",
      amountCents: -50_000,
    });
    handle.sqlite.pragma("foreign_keys = OFF");
    try {
      handle.db
        .update(schema.transactions)
        .set({ transferPairId: leg.id + 999_999 }) // points at nothing
        .where(eq(schema.transactions.id, leg.id))
        .run();
    } finally {
      handle.sqlite.pragma("foreign_keys = ON");
    }

    const rows = loadTransactions(handle.db, { ...base, includeTransfers: true }).rows;
    const row = rows.find((r) => r.id === leg.id)!;
    expect(row.pairIsAppCreated).toBe(false);
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
 * 11 of 181 merchant groups into supersets — clicking `AMAZON` (59 rows for
 * the exact key) would land on 71, silently including `AMAZON PRIME`, which
 * is a different merchant filed to a different category.
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
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "GASCO#00000ANYTWN" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ST DMV 000 *SVC" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "UTIL CO/EZ-PAY" });

    for (const key of ["GASCO#00000ANYTWN", "ST DMV 000 *SVC", "UTIL CO/EZ-PAY"]) {
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
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "FUELCO", categoryId: gas.id, date: "2026-04-02" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "FUELCO", categoryId: null, date: "2026-04-03" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "FUELCO", categoryId: null, date: "2026-05-03" });

    const filter = { merchant: "FUELCO", dateFrom: "2026-04-01", dateTo: "2026-04-30" };
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

/**
 * `summarizeByCategory` shares `buildPredicates` with the list, and these pin
 * the two consequences of that sharing that nothing else reached.
 *
 * The transfer case is the one with teeth. The merchant header renders
 * "Categorize all N →" straight off this breakdown's NULL bucket, and
 * `/categorize` refuses to show transfer-paired rows at all — so a
 * summarizer that stopped excluding them would offer to categorize rows the
 * pair machinery owns, from a link whose destination cannot list them.
 */
describe("summarizeByCategory — transfer-paired rows (shared predicates)", () => {
  function seedPair(accountId: number, batchId: number, merchant: string) {
    const anchor = seedTxn({ accountId, batchId, merchant, amountCents: -2500 });
    const partner = seedTxn({ accountId, batchId, merchant, amountCents: 2500 });
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: partner.id })
      .where(eq(schema.transactions.id, anchor.id))
      .run();
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: anchor.id })
      .where(eq(schema.transactions.id, partner.id))
      .run();
  }

  it("excludes paired rows by default, exactly as the list beneath it does", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedPair(a.id, b.id, "ZELLE");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ZELLE", categoryId: null });

    const filter = { merchant: "ZELLE" };
    const breakdown = summarizeByCategory(handle.db, filter);
    const { totalCount } = loadTransactions(handle.db, { ...filter, page: 1, pageSize: 50 });

    expect(breakdown.reduce((n, r) => n + r.count, 0)).toBe(totalCount);
    expect(breakdown).toEqual([{ categoryId: null, categoryName: null, count: 1 }]);
  });

  it("reveals them when includeTransfers is set, still agreeing with the list", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedPair(a.id, b.id, "ZELLE");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ZELLE", categoryId: null });

    const filter = { merchant: "ZELLE", includeTransfers: true };
    const breakdown = summarizeByCategory(handle.db, filter);
    const { totalCount } = loadTransactions(handle.db, { ...filter, page: 1, pageSize: 50 });

    expect(breakdown.reduce((n, r) => n + r.count, 0)).toBe(totalCount);
    expect(totalCount).toBe(3);
  });
});

/**
 * The `totalCount !== 0` branch of `/transactions`' zero-result state, which
 * renders "This page is empty — there are rows in this filter, just not this
 * far in" and a Back-to-page-1 link. It is reachable from an ordinary
 * bookmark: page 3 of a filter that has since shrunk. If `totalCount` were
 * ever computed over the paged window rather than the whole predicate, that
 * card would flip to "No transactions match this filter" and tell the user
 * their filter is empty when it is not.
 */
describe("loadTransactions — a page past the end", () => {
  it("returns no rows while still reporting the filter's real totalCount", () => {
    const a = seedAccount();
    const b = seedBatch();
    for (let i = 0; i < 5; i += 1) {
      seedTxn({ accountId: a.id, batchId: b.id, date: `2026-04-0${i + 1}` });
    }

    const past = loadTransactions(handle.db, { page: 4, pageSize: 2 });
    expect(past.rows).toEqual([]);
    expect(past.totalCount).toBe(5);
  });
});

/**
 * `importSource` on the row — added in v0.26.0 and, until now, selected by
 * `loadTransactions` and asserted by nothing.
 *
 * It is not decoration. `_transaction-row.tsx` passes
 * `isManual={row.importSource === "manual"}` into the row menu, and that flag
 * alone decides whether "Remove this charge…" is offered. Drop the column from
 * the SELECT and `row.importSource` is `undefined` for every row, so the
 * comparison is false everywhere and the menu item silently disappears from the
 * only surface that can reach `removeCardActivity` — the ledger looks fine, the
 * repair path is simply gone. Nothing else in the suite would fail.
 *
 * The converse matters just as much: a bank row must never report `manual`, or
 * the menu offers a delete the server then refuses with `not-manual` — a
 * refusal the user can only discover by triggering it.
 */
describe("loadTransactions — importSource", () => {
  it("returns each row's write path verbatim, so the row menu can gate on it", () => {
    const a = seedAccount();
    const b = seedBatch();
    const cat = seedCategory("Dining");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "HAND-ENTERED",
      categoryId: cat.id,
      importSource: "manual",
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "FROM-CSV", importSource: "csv" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "FROM-FEED", importSource: "simplefin" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    const byMerchant = new Map(r.rows.map((row) => [row.normalizedMerchant, row.importSource]));

    expect(byMerchant.get("HAND-ENTERED")).toBe("manual");
    // Neither bank path may masquerade as hand-entered.
    expect(byMerchant.get("FROM-CSV")).toBe("csv");
    expect(byMerchant.get("FROM-FEED")).toBe("simplefin");
  });
});

/**
 * `filedCategoryIds` — TODOS.md's "`/transactions` still cannot disable the
 * Remember checkbox the way `/categorize` does" follow-up. Backed by
 * `loadFiledCategoryCountsByMerchant` (the same shared predicate
 * `loadMerchantGroups` reads through `loadFiledCategoryIdsByMerchant`), so
 * the two share ONE spelling of "which filings count as evidence" — a
 * divergence THERE is exactly what would let the checkbox render enabled and
 * then have the server refuse the submit.
 *
 * This is deliberately NOT "the two figures always agree": a categorized
 * `/transactions` row self-excludes its own sole-contributed category from
 * its own `filedCategoryIds` (see the field's docstring in
 * `loadTransactions.ts`), which `/categorize`'s group-level figure has no
 * row to do for. The parity block in `resolveKeyTrainability.test.ts` pins
 * exactly where the two are expected to diverge and warns that re-agreement
 * would be the regression — read that one first if this comment and that one
 * seem to disagree.
 */
describe("loadTransactions — filedCategoryIds", () => {
  it("is empty for a merchant key nothing has been filed under yet", () => {
    const a = seedAccount();
    const b = seedBatch();
    const row = seedTxn({ accountId: a.id, batchId: b.id, merchant: "NEWPLACE" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    expect(r.rows.find((x) => x.id === row.id)?.filedCategoryIds).toEqual([]);
  });

  it("carries the category of another row sharing the same merchant key", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      categoryId: groceries.id,
    });
    const uncategorized = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    expect(r.rows.find((x) => x.id === uncategorized.id)?.filedCategoryIds).toEqual([
      groceries.id,
    ]);
  });

  it("carries every distinct category the key has been filed under, across rows on the page", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", categoryId: groceries.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", categoryId: dining.id });
    const uncategorized = seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    const ids = r.rows.find((x) => x.id === uncategorized.id)?.filedCategoryIds ?? [];
    expect(new Set(ids)).toEqual(new Set([groceries.id, dining.id]));
  });

  it("does not count a filing under an archived category, matching /categorize's predicate", () => {
    const a = seedAccount();
    const b = seedBatch();
    const retired = seedCategory("Retired");
    handle.db
      .update(schema.categories)
      .set({ archivedAt: new Date("2026-06-01T00:00:00.000Z") })
      .where(eq(schema.categories.id, retired.id))
      .run();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "OLDPLACE", categoryId: retired.id });
    const uncategorized = seedTxn({ accountId: a.id, batchId: b.id, merchant: "OLDPLACE" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    expect(r.rows.find((x) => x.id === uncategorized.id)?.filedCategoryIds).toEqual([]);
  });

  it("does not count a filing on a transfer-paired row — /categorize never shows it", () => {
    const a = seedAccount();
    const b = seedBatch();
    const dining = seedCategory("Dining");
    const partner = seedTxn({ accountId: a.id, batchId: b.id, merchant: "PARTNER", amountCents: 4000 });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "CHIPOTLE",
      categoryId: dining.id,
      transferPairId: partner.id,
    });
    const uncategorized = seedTxn({ accountId: a.id, batchId: b.id, merchant: "CHIPOTLE" });

    const r = loadTransactions(handle.db, {
      page: 1,
      pageSize: 50,
      includeTransfers: true,
    });
    expect(r.rows.find((x) => x.id === uncategorized.id)?.filedCategoryIds).toEqual([]);
  });

  it("batches correctly across several distinct merchants on one page, each keeping its own set", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const gas = seedCategory("Gas");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", categoryId: groceries.id });
    const amazonRow = seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SHELL", categoryId: gas.id });
    const shellRow = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SHELL" });
    const freshRow = seedTxn({ accountId: a.id, batchId: b.id, merchant: "NEWPLACE" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    const byId = new Map(r.rows.map((row) => [row.id, row.filedCategoryIds]));
    expect(byId.get(amazonRow.id)).toEqual([groceries.id]);
    expect(byId.get(shellRow.id)).toEqual([gas.id]);
    expect(byId.get(freshRow.id)).toEqual([]);
  });
});

/**
 * `existingRule` — the other half of the ship-review fix (Codex adversarial +
 * structured, cross-model): `describeRuleAction` (`keyTrainability.ts`) needs
 * this alongside `filedCategoryIds` to tell "genuinely nothing to do" apart
 * from "can't train, but ticking Remember would still remove a rule this
 * pick contradicts."
 */
describe("loadTransactions — existingRule", () => {
  it("is null for a merchant with no exact rule", () => {
    const a = seedAccount();
    const b = seedBatch();
    const row = seedTxn({ accountId: a.id, batchId: b.id, merchant: "NEWPLACE" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    expect(r.rows.find((x) => x.id === row.id)?.existingRule).toBeNull();
  });

  it("carries the exact rule's category and name", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SAFEWAY",
      categoryId: groceries.id,
      source: "manual",
    });
    const row = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    expect(r.rows.find((x) => x.id === row.id)?.existingRule).toEqual({
      categoryId: groceries.id,
      categoryName: groceries.name,
    });
  });

  it("batches correctly across several distinct merchants on one page", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const gas = seedCategory("Gas");
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "AMAZON",
      categoryId: groceries.id,
      source: "manual",
    });
    createOrUpdateRule(handle.db, {
      normalizedMerchant: "SHELL",
      categoryId: gas.id,
      source: "manual",
    });
    const amazonRow = seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON" });
    const shellRow = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SHELL" });
    const freshRow = seedTxn({ accountId: a.id, batchId: b.id, merchant: "NEWPLACE" });

    const r = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    const byId = new Map(r.rows.map((row) => [row.id, row.existingRule]));
    expect(byId.get(amazonRow.id)).toEqual({ categoryId: groceries.id, categoryName: groceries.name });
    expect(byId.get(shellRow.id)).toEqual({ categoryId: gas.id, categoryName: gas.name });
    expect(byId.get(freshRow.id)).toBeNull();
  });
});
