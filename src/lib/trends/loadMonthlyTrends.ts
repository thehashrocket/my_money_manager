import { ne, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { currentMonth as getCurrentMonth } from "@/lib/now";
import { monthBoundary, nMonthsBack } from "@/lib/budget/monthOfIso";

type Db = typeof defaultDb;

/**
 * SIGN CONVENTION (decided 2026-09-08) — spend is a SIGNED sum, so a refund
 * reduces the category's spend for that month. This chart and
 * `computeMtdSpent` (`src/lib/budget.ts`) now agree; before this they did
 * not, and the disagreement was live: September 2026 read $10.00 of Misc on
 * `/budget` and $295.00 here, because this query summed only the outbound
 * legs of five transfer reversals that cancel under a signed sum.
 *
 * Envelope budgeting is the argument: returning $20 of groceries restores
 * $20 of grocery-buying capacity, and `leftToBudgetCents` is computed from
 * `computeMtdSpent`, so matching THAT side is the only version of this fix
 * that leaves the zero-based math untouched.
 *
 *   transactions (transfer_pair_id IS NULL, category kind = 'expense')
 *           │
 *           ├─ computeMtdSpent()    = 0 − SUM(amount_cents)   per category-month
 *           └─ loadMonthlyTrends()  = 0 − SUM(amount_cents)   per group-month
 *                                     ▲ same expression, deliberately
 *
 * A month where refunds exceed spend yields a NEGATIVE `spentCents`. That is
 * reported rather than clamped — clamping would reintroduce the same class of
 * lie this change removes. Zero such cells exist on the live ledger across the
 * 6-month window (measured 2026-09-08), so the stacked bars are unaffected in
 * practice; a future one renders below the axis, which is the honest picture.
 */

export type CategorySpend = {
  name: string;
  spentCents: number;
};

export type MonthTrend = {
  year: number;
  month: number;
  label: string;
  /**
   * The month's net spend across drawn groups. NOTE: no production code reads
   * this any more — `isEmpty` moved to `byCategory.length` when a net-zero
   * month stopped implying an empty one. Kept because it is the month total a
   * consumer would reach for, and asserted in tests; do not treat its value as
   * load-bearing for rendering without re-checking that.
   */
  totalSpentCents: number;
  byCategory: CategorySpend[];
};

export type TrendData = {
  months: MonthTrend[];
  categoryNames: string[];
};

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function loadMonthlyTrends(db: Db, monthCount = 6): TrendData {
  const { year: currentYear, month: currentMonth } = getCurrentMonth();

  const { year: startYear, month: startMonth } = nMonthsBack(
    currentYear,
    currentMonth,
    monthCount - 1,
  );
  const startDate = monthBoundary(startYear, startMonth);

  // Build leaf → parent name map (excluding savings goals)
  const allCategories = db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
    })
    .from(schema.categories)
    // A2: kind is authoritative, not is_savings_goal (T5).
    .where(ne(schema.categories.kind, "fund"))
    .all();

  const categoryNameById = new Map<number, string>();
  const parentIdById = new Map<number, number | null>();
  for (const c of allCategories) {
    categoryNameById.set(c.id, c.name);
    parentIdById.set(c.id, c.parentId);
  }

  // Resolve leaf → root parent name ("Other" for ungrouped leaves)
  function resolveGroupName(categoryId: number): string {
    const parentId = parentIdById.get(categoryId);
    if (parentId == null) return categoryNameById.get(categoryId) ?? "Other";
    return categoryNameById.get(parentId) ?? "Other";
  }

  // Aggregate spend per leaf category per month.
  //
  // The `kind = 'expense'` subquery is load-bearing and replaces the
  // `amount_cents < 0` filter this query used to carry. That filter was doing
  // TWO jobs at once: dropping refunds (the bug — see the sign convention note
  // at the top of this file) and, incidentally, dropping every income row,
  // since income is positive. Removing it without this subquery would pull 43
  // paycheck/interest rows worth +$52,131.17 into the last six months and
  // render them as ~$52k of NEGATIVE spend. Filter on the category's kind,
  // which is what "is this spending" actually means, not on the amount's sign.
  const spendRows = db
    .select({
      yr: sql<string>`strftime('%Y', ${schema.transactions.date})`,
      mo: sql<string>`strftime('%m', ${schema.transactions.date})`,
      categoryId: schema.transactions.categoryId,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      sql`${schema.transactions.transferPairId} IS NULL
        AND ${schema.transactions.categoryId} IS NOT NULL
        AND ${schema.transactions.categoryId} IN (
          SELECT ${schema.categories.id} FROM ${schema.categories}
          WHERE ${schema.categories.kind} = 'expense'
        )
        AND ${schema.transactions.date} >= ${startDate}`,
    )
    .groupBy(
      sql`strftime('%Y', ${schema.transactions.date})`,
      sql`strftime('%m', ${schema.transactions.date})`,
      schema.transactions.categoryId,
    )
    .all();

  // Build month frame oldest → newest
  const months: MonthTrend[] = [];
  const totalByGroup = new Map<string, number>();

  for (let i = 0; i < monthCount; i++) {
    const { year: y, month: m } = nMonthsBack(currentYear, currentMonth, monthCount - 1 - i);
    months.push({
      year: y,
      month: m,
      label: monthLabel(y, m),
      totalSpentCents: 0,
      byCategory: [],
    });
  }

  // Bucket rows into month frame
  const spendByMonthAndGroup = new Map<string, Map<string, number>>();
  for (const row of spendRows) {
    if (row.categoryId === null) continue;
    // Skip savings-goal categories — they don't appear in the category name map
    if (!categoryNameById.has(row.categoryId) && !parentIdById.has(row.categoryId)) continue;
    const groupName = resolveGroupName(row.categoryId);
    const key = `${row.yr}-${row.mo}`;
    const bucket = spendByMonthAndGroup.get(key) ?? new Map<string, number>();
    const prev = bucket.get(groupName) ?? 0;
    // Same expression as `computeMtdSpent`: negate the signed sum so ordinary
    // spending reads positive. A refund-heavy month stays negative on purpose.
    const spend = 0 - row.total;
    bucket.set(groupName, prev + spend);
    spendByMonthAndGroup.set(key, bucket);

    totalByGroup.set(groupName, (totalByGroup.get(groupName) ?? 0) + spend);
  }

  // Groups that actually draw a bar in at least one month. Accumulated here
  // rather than re-derived below, because it is the SAME decision as the
  // per-month zero-drop and must not be able to disagree with it.
  const drawnGroups = new Set<string>();

  for (const month of months) {
    const key = `${String(month.year).padStart(4, "0")}-${String(month.month).padStart(2, "0")}`;
    const bucket = spendByMonthAndGroup.get(key);
    if (bucket) {
      let total = 0;
      const byCategory: CategorySpend[] = [];
      for (const [name, spentCents] of bucket.entries()) {
        // A group that nets to EXACTLY zero is dropped rather than emitted as
        // a zero. Under the signed convention that is now reachable — a
        // reversal pair filed to one category cancels itself — and a zero
        // entry draws a legend swatch attached to a bar of no height, which
        // reads as a category you spent nothing in rather than one whose
        // movements offset. Genuine negatives are NOT dropped: those are real
        // and belong below the axis.
        if (spentCents === 0) continue;
        byCategory.push({ name, spentCents });
        drawnGroups.add(name);
        total += spentCents;
      }
      month.totalSpentCents = total;
      month.byCategory = byCategory.sort((a, b) => b.spentCents - a.spentCents);
    }
  }

  // Stable category name list: sorted by six-month total spend descending.
  //
  // The membership test is "does this group draw a bar in ANY month", NOT "is
  // its six-month total non-zero". Those are different questions and the
  // difference is silent data loss: a $50 charge in March refunded in April
  // nets to EXACTLY zero across the window while drawing a real bar in both
  // months. `TrendChart` maps this list to its `<Bar>` elements and its
  // legend, and `isEmpty` keys off `byCategory` instead — so a `total !== 0`
  // filter here rendered a chart with axes, no bars and no legend over two
  // months of real activity. Only the per-month drop above decides what is
  // drawable; this list just orders what that decision produced.
  const categoryNames = [...totalByGroup.entries()]
    .filter(([name]) => drawnGroups.has(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  return { months, categoryNames };
}
