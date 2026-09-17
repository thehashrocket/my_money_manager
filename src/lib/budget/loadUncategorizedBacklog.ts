import { and, isNull, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import type { YearMonth } from "./monthOfIso";
import { monthDatePredicates } from "@/lib/transactions/monthDatePredicates";

type Db = typeof defaultDb;

export type UncategorizedBacklog = {
  count: number;
  /** Signed sum of `amount_cents` (spend is negative; refunds positive). */
  totalCents: number;
};

/**
 * X4 + E5: extracted from `loadMonthView` so `/categorize` and
 * `/transactions` — which only ever wanted this one COUNT(*) + SUM — stop
 * building and discarding a full month view (every allocation, every spend
 * sum, the rollover scan) to get it. `loadMonthView` passes `scope` so its
 * own `uncategorizedBacklog` field narrows to the month actually being
 * viewed — without a scope, September's `received` figure could read short
 * with no local explanation while the banner blamed 498 rows from every
 * month.
 *
 * `/transactions` calls this unscoped (all-time), matching its own
 * all-time page. `/categorize` did too until its own month-scope feature
 * landed — it now passes the PAGE's parsed `?year=&month=` scope straight
 * through, so its counter always agrees with the scoped list rendered
 * beside it rather than staying pinned to all-time. `loadMonthView` is no
 * longer the only `scope`-passing caller.
 */
export function loadUncategorizedBacklog(
  db: Db,
  scope?: YearMonth,
): UncategorizedBacklog {
  const datePredicates = monthDatePredicates(scope);

  const row = db
    .select({
      count: sql<number>`COUNT(*)`,
      total: sql<number>`COALESCE(SUM(${schema.transactions.amountCents}), 0)`,
    })
    .from(schema.transactions)
    .where(
      and(
        isNull(schema.transactions.categoryId),
        isNull(schema.transactions.transferPairId),
        ...datePredicates,
      ),
    )
    .get();

  return {
    count: row?.count ?? 0,
    totalCents: row?.total ?? 0,
  };
}
