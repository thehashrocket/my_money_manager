import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadTransactions } from "@/lib/categorize/loadTransactions";
import { nextMonthOf } from "./monthOfIso";
import { transactionsDrilldownHref } from "./transactionsDrilldownHref";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedAccount() {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: `Checking-${seq}`,
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

function seedTxn(opts: { accountId: number; batchId: number; categoryId: number; date: string }) {
  seq += 1;
  handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: "MERCHANT",
      amountCents: -1000,
      categoryId: opts.categoryId,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      isPending: false,
    })
    .run();
}

/**
 * D9 regression guard: `/budget`'s drilldown link used to filter
 * `/transactions` with `year`+`month` (a `[first_day, first_of_next_month)`
 * window, reimplemented here as the old behavior). It now builds
 * `dateFrom`/`dateTo` via `transactionsDrilldownHref`. This pins that the new
 * link produces the SAME effective row set as the retired filter did, for a
 * representative month on each end of the calendar (a December year-rollover
 * and a leap-year February) — the exact silent-wrong-result class D9 exists
 * to prevent.
 */
function loadWithOldYearMonthFilter(
  db: TestDbHandle["db"],
  categoryId: number,
  year: number,
  month: number,
) {
  const { year: ny, month: nm } = nextMonthOf(year, month);
  return loadTransactions(db, {
    categoryId,
    dateFrom: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`,
    dateTo: undefined,
    page: 1,
    pageSize: 50,
  }).rows.filter((row) => row.date < `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`);
}

describe("transactionsDrilldownHref (D9 regression guard)", () => {
  it("builds a URL with categoryId, dateFrom, and dateTo (no year/month params)", () => {
    const href = transactionsDrilldownHref(42, 2026, 4);
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/transactions");
    expect(url.searchParams.get("categoryId")).toBe("42");
    expect(url.searchParams.get("dateFrom")).toBe("2026-04-01");
    expect(url.searchParams.get("dateTo")).toBe("2026-04-30");
    expect(url.searchParams.has("year")).toBe(false);
    expect(url.searchParams.has("month")).toBe(false);
  });

  it("matches the same transactions the old year/month filter selected, across a December rollover", () => {
    const a = seedAccount();
    const b = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id, date: "2026-11-30" });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id, date: "2026-12-01" });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id, date: "2026-12-31" });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id, date: "2027-01-01" });

    const oldRows = loadWithOldYearMonthFilter(handle.db, cat.id, 2026, 12);

    const href = transactionsDrilldownHref(cat.id, 2026, 12);
    const url = new URL(href, "http://localhost");
    const newRows = loadTransactions(handle.db, {
      categoryId: cat.id,
      dateFrom: url.searchParams.get("dateFrom")!,
      dateTo: url.searchParams.get("dateTo")!,
      page: 1,
      pageSize: 50,
    }).rows;

    expect(newRows.map((r) => r.date).sort()).toEqual(["2026-12-01", "2026-12-31"]);
    expect(newRows.map((r) => r.id).sort()).toEqual(oldRows.map((r) => r.id).sort());
  });

  it("matches the same transactions the old year/month filter selected, for a leap-year February", () => {
    const a = seedAccount();
    const b = seedBatch();
    const cat = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id, date: "2028-01-31" });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id, date: "2028-02-01" });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id, date: "2028-02-29" });
    seedTxn({ accountId: a.id, batchId: b.id, categoryId: cat.id, date: "2028-03-01" });

    const oldRows = loadWithOldYearMonthFilter(handle.db, cat.id, 2028, 2);

    const href = transactionsDrilldownHref(cat.id, 2028, 2);
    const url = new URL(href, "http://localhost");
    const newRows = loadTransactions(handle.db, {
      categoryId: cat.id,
      dateFrom: url.searchParams.get("dateFrom")!,
      dateTo: url.searchParams.get("dateTo")!,
      page: 1,
      pageSize: 50,
    }).rows;

    expect(newRows.map((r) => r.date).sort()).toEqual(["2028-02-01", "2028-02-29"]);
    expect(newRows.map((r) => r.id).sort()).toEqual(oldRows.map((r) => r.id).sort());
  });
});
