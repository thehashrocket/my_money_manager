import { inArray, sql } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";

// Derived, not retyped: a hand-duplicated union would silently drift the
// moment the schema's enum gains or loses a kind. This is the copy that
// propagates — `loadMonthView` re-exports it onto LeafRow, IncomeLeafRow and
// FundRow, and `_month-editor.tsx` imports it from there.
export type CategoryKind = (typeof schema.categories.$inferSelect)["kind"];

// Re-exported, not defined here: this module imports drizzle and `@/db`, and
// the two consumers of the predicate are `"use client"` files, so a VALUE
// import from here would pull better-sqlite3 into the browser bundle (the
// measured +376 KB shape CLAUDE.md records for `limits.ts`). It lives in a
// DB-free module and is re-exported so server-side readers still find rule 8's
// vocabulary in one place.
export { kindsImplyUsed } from "./kindsImplyUsed";

/**
 * The three counts rule 8's "is this category used?" test reads, and nothing
 * more. Split out from `setCategoryKind`'s inline queries so the READ side can
 * answer the same question without re-deriving it — see {@link assignableKinds}.
 */
export type CategoryKindUsage = {
  txnCount: number;
  /** Rows with `amount_cents < 0`. Only X1 reads it. */
  negativeTxnCount: number;
  periodCount: number;
};

export const NO_USAGE: CategoryKindUsage = { txnCount: 0, negativeTxnCount: 0, periodCount: 0 };

/**
 * Rule 8's `isUsed`: a category is "used" once it has a transaction OR a
 * `budget_periods` row.
 *
 * The `periodCount` half is what makes this newly reachable for a FUND. Before
 * the FUNDS band became editable (v0.23.0) a fund had no write path to a
 * `budget_periods` row at all, so `isUsed` was effectively transactions-only
 * for `kind='fund'`. Now typing anything into the band's `AllocationCell` —
 * including `$0` — or one click of "Copy previous month" (`copyMonth` has no
 * kind filter) writes one.
 */
export function isCategoryUsed(usage: CategoryKindUsage): boolean {
  return usage.txnCount > 0 || usage.periodCount > 0;
}

/**
 * Which kinds `setCategoryKind` will ACCEPT for a category with this usage —
 * the ONE spelling of rule 8, shared by the writer that enforces it
 * (`setCategoryKind`) and the read model that has to render an honest menu
 * (`loadMonthView` → `CategoryMenu`).
 *
 * It existed only inside the writer until this change, which is how the menu
 * came to offer "Set kind: expense" on a fund that had acquired a
 * `budget_periods` row — an item that from that moment always refuses. That is
 * exactly the "discovered only after a refused submit" shape DS32 names.
 *
 * The current kind is always included: `setCategoryKind` short-circuits
 * `previousKind === newKind` to a no-op success before it ever consults usage.
 * The menu disables that one anyway, for the unrelated reason that it is
 * already current.
 *
 * X1 (rule 8) is the single relaxation, and it is deliberately NOT generalised
 * to a fund. Its guard is `negativeTxnCount === 0` — real evidence from the
 * rows that the category was always income. A fund locked by a *planned* row
 * has no equivalent evidence to offer, and a `budget_periods` row is genuine
 * usage in three subsystems at once (it moves `leftToBudget`, it decides
 * rollover eligibility, and `loadGoals` sums it for `totalContributedCents`),
 * so relaxing on its absence would be relaxing on no signal at all.
 */
export function assignableKinds(previousKind: CategoryKind, usage: CategoryKindUsage): CategoryKind[] {
  if (!isCategoryUsed(usage)) return ["expense", "income", "fund"];

  const kinds: CategoryKind[] = [previousKind];
  const isX1Eligible = previousKind === "expense" && usage.txnCount > 0 && usage.negativeTxnCount === 0;
  if (isX1Eligible) kinds.push("income");
  return kinds;
}

/**
 * Why this category's kind is locked, in the fewest words that still name the
 * cause — or `null` when it is not locked.
 *
 * This exists because hiding the offer is only half of DS32. `setCategoryKind`
 * produces a refusal carrying real evidence (the transaction count and date
 * range, or "already has a budget planned"), and the `⋯` menu on `/budget` is
 * the ONLY surface in the app that can reach `setCategoryKindAction` —
 * `/budget/categories` renders kind read-only. So dropping the menu block on a
 * locked category made that explanation unreachable and left the user unable to
 * tell "not allowed" from "this app has no kind control", which is a different
 * failure from the one the fix was for and not obviously a smaller one.
 *
 * Deliberately NOT the writer's full sentence: the menu has room for a label,
 * not a paragraph, and the date range the writer quotes is not loaded here.
 * Transactions are named before planned months because a transaction is the
 * harder fact to argue with — and because the planned-row case is the one a
 * user can reach by accident, so it is worth saying plainly that a `$0` entry
 * counts.
 */
export function kindLockReason(usage: CategoryKindUsage): string | null {
  if (!isCategoryUsed(usage)) return null;
  if (usage.txnCount > 0) {
    return `${usage.txnCount} transaction${usage.txnCount === 1 ? "" : "s"} filed here`;
  }
  return "a month is already budgeted here";
}

/**
 * Batched usage counts for a set of categories, as two grouped queries rather
 * than one pair per category — `loadMonthView` calls this once for every leaf
 * on the page.
 *
 * A category with no rows in either table is absent from both result sets and
 * so absent from the returned map; callers read a miss as {@link NO_USAGE}
 * (which is what "never used" means) rather than as an error.
 */
export function loadCategoryKindUsage(db: AnyDb, categoryIds: number[]): Map<number, CategoryKindUsage> {
  const usage = new Map<number, CategoryKindUsage>();
  if (categoryIds.length === 0) return usage;

  const txnRows = db
    .select({
      categoryId: schema.transactions.categoryId,
      count: sql<number>`COUNT(*)`,
      negativeCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amountCents} < 0 THEN 1 ELSE 0 END), 0)`,
    })
    .from(schema.transactions)
    .where(inArray(schema.transactions.categoryId, categoryIds))
    .groupBy(schema.transactions.categoryId)
    .all();

  for (const row of txnRows) {
    if (row.categoryId === null) continue;
    usage.set(row.categoryId, {
      txnCount: row.count,
      negativeTxnCount: row.negativeCount,
      periodCount: 0,
    });
  }

  const periodRows = db
    .select({
      categoryId: schema.budgetPeriods.categoryId,
      count: sql<number>`COUNT(*)`,
    })
    .from(schema.budgetPeriods)
    .where(inArray(schema.budgetPeriods.categoryId, categoryIds))
    .groupBy(schema.budgetPeriods.categoryId)
    .all();

  for (const row of periodRows) {
    const existing = usage.get(row.categoryId) ?? { ...NO_USAGE };
    usage.set(row.categoryId, { ...existing, periodCount: row.count });
  }

  return usage;
}
