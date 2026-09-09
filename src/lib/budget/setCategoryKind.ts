import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { assignableKinds, isCategoryUsed, type CategoryKind } from "@/lib/budget/categoryKindLock";
import { CategoryNotFoundError } from "@/lib/categoryErrors";

type Db = typeof defaultDb;
// Re-exported, not re-declared: `categoryKindLock` owns rule 8 and the type
// it is stated in, so the two cannot drift apart.
export type { CategoryKind };

/**
 * Candidates for the F1 banner's reclassify picker: leaf, expense-kind,
 * non-archived categories — the only starting kind X1 permits a used
 * category to leave. `setCategoryKind` itself enforces the real rule; this
 * list is just what's worth offering rather than every category the action
 * would refuse anyway. Excludes archived categories for the same reason
 * `listLeafCategories`'s `includeArchived` guard does (X3/B7): reclassifying
 * one wouldn't actually fix F1's "no income categories" banner, since an
 * archived category stays hidden from the budget grid regardless of `kind`
 * — offering it here would let the dialog report success while the banner
 * silently persists.
 */
export function listExpenseLeafCategories(db: Db): { id: number; name: string }[] {
  const parentIds = db
    .selectDistinct({ parentId: schema.categories.parentId })
    .from(schema.categories)
    .all()
    .map((r) => r.parentId)
    .filter((id): id is number => id !== null);

  const rows = db
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(
      parentIds.length > 0
        ? and(
            eq(schema.categories.kind, "expense"),
            isNull(schema.categories.archivedAt),
            notInArray(schema.categories.id, parentIds),
          )
        : and(eq(schema.categories.kind, "expense"), isNull(schema.categories.archivedAt)),
    )
    .all();

  // The seed "Uncategorized" category is the default-override target for
  // unmatched rows (CLAUDE.md rule 6), not a real income source — offering it
  // here would let a stray positive manual override flip it to income/fund
  // via X1 and break every downstream `category_id IS NULL` backlog check.
  return [...rows]
    .filter((r) => r.name !== "Uncategorized")
    .sort((a, b) => a.name.localeCompare(b.name));
}

export type ReclassifyCandidate = {
  id: number;
  name: string;
  transactionCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  /** X1's exact test, precomputed so the confirmation dialog can state it
   * as evidence up front (DS32) instead of only discovering it on submit. */
  allPositive: boolean;
};

/**
 * DS32: the reclassify dialog states a concrete count, date range, and the
 * all-positive check X1 requires — as evidence, not a precondition
 * discovered only after a refused submit. One grouped query across every
 * candidate rather than one query per row in the picker.
 *
 * A category with a `budget_periods` row but zero transactions is excluded
 * entirely rather than listed with `allPositive: true` — `setCategoryKind`'s
 * D9A "used" check refuses it regardless of `allPositive` (X1's exception
 * requires `count > 0`, not just "no negative rows"), so listing it here
 * would be exactly the "discovered only after a refused submit" case DS32
 * exists to prevent.
 */
export function loadReclassifyCandidates(db: Db): ReclassifyCandidate[] {
  const leaves = listExpenseLeafCategories(db);
  if (leaves.length === 0) return [];

  const leafIds = leaves.map((l) => l.id);

  const statRows = db
    .select({
      categoryId: schema.transactions.categoryId,
      count: sql<number>`COUNT(*)`,
      negativeCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amountCents} < 0 THEN 1 ELSE 0 END), 0)`,
      earliestDate: sql<string | null>`MIN(${schema.transactions.date})`,
      latestDate: sql<string | null>`MAX(${schema.transactions.date})`,
    })
    .from(schema.transactions)
    .where(inArray(schema.transactions.categoryId, leafIds))
    .groupBy(schema.transactions.categoryId)
    .all();

  const statsById = new Map(statRows.map((r) => [r.categoryId as number, r]));

  const plannedCategoryIds = new Set(
    db
      .selectDistinct({ categoryId: schema.budgetPeriods.categoryId })
      .from(schema.budgetPeriods)
      .where(inArray(schema.budgetPeriods.categoryId, leafIds))
      .all()
      .map((r) => r.categoryId),
  );

  return leaves
    .filter((leaf) => !plannedCategoryIds.has(leaf.id))
    .map((leaf) => {
      const stat = statsById.get(leaf.id);
      return {
        id: leaf.id,
        name: leaf.name,
        transactionCount: stat?.count ?? 0,
        earliestDate: stat?.earliestDate ?? null,
        latestDate: stat?.latestDate ?? null,
        allPositive: (stat?.negativeCount ?? 0) === 0,
      };
    });
}

/**
 * D9A: a used category (≥1 transaction or ≥1 `budget_periods` row) refuses
 * reclassification. Carries what the confirmation dialog (DS32) needs to
 * name concretely — a count and a date range, never a generic warning.
 */
export class CategoryKindChangeRefusedError extends Error {
  constructor(
    readonly categoryId: number,
    readonly categoryName: string,
    readonly transactionCount: number,
    readonly earliestDate: string | null,
    readonly latestDate: string | null,
  ) {
    super(
      transactionCount > 0
        ? `"${categoryName}" has ${transactionCount} transaction${transactionCount === 1 ? "" : "s"} (${earliestDate} – ${latestDate}) and cannot be reclassified.`
        : `"${categoryName}" already has a budget planned for at least one month and cannot be reclassified.`,
    );
    this.name = "CategoryKindChangeRefusedError";
  }
}

/**
 * The seed "Uncategorized" category is excluded from `listExpenseLeafCategories`
 * (the reclassify picker), but that is a UI-layer courtesy, not a guarantee —
 * `setCategoryKind` is a general-purpose function any future caller (a script,
 * a bulk operation, a bug in a different picker) could invoke directly with
 * Uncategorized's real id. And unlike an ordinary category, Uncategorized is
 * frequently "used" with zero transactions pointed at it (NULL is the real
 * default per CLAUDE.md rule 6, not this row's id) and zero budget_periods
 * rows, so the ordinary `isUsed` refusal would not catch it either. Refuse
 * unconditionally, at the actual write boundary, matching the same by-name
 * convention the `categories_uncategorized_no_delete` trigger already uses.
 */
/**
 * The change is legal (X1 admits it) but nothing confirmed it.
 *
 * X1 — expense → income on a USED category — is one-way: rule 8 refuses
 * income → expense on a used category, so there is no path back in the app.
 * `CategoryMenu` gates it behind a confirmation dialog, but that gate is
 * decided from a SERVER-RENDERED prop and `commitAllocationAction`
 * deliberately does not revalidate, so the prop is stale by design. Concrete
 * miss: a tab renders a category as unused, "Copy previous month" creates a
 * `budget_periods` row in another tab, and the stale tab now offers the change
 * with no dialog, no ellipsis and no destructive styling — while X1 accepts it,
 * because `negativeTxnCount === 0` is vacuously true at zero rows.
 *
 * So the confirmation is a fact the SERVER checks, not one the client is
 * trusted to have performed. Absence is a refusal, which is the same shape
 * rule 4 arrived at for the reversal form's `intent` after the mirror-image
 * bug: never let absence be the affirmative signal for the irreversible branch.
 *
 * Note the threat model is a STALE TAB, not a crafted post — this app is
 * single-user, local and unauthenticated, so a hand-built form could always
 * set the flag. What it cannot do is set it by accident, which is the entire
 * population of real occurrences.
 */
export class UnconfirmedIrreversibleKindChangeError extends Error {
  constructor(
    readonly categoryId: number,
    readonly categoryName: string,
  ) {
    super(
      `"${categoryName}" already has activity, so changing it to income cannot be undone in the app. ` +
        `Reload the page and use the confirmation step — this tab's view of the category is out of date.`,
    );
    this.name = "UnconfirmedIrreversibleKindChangeError";
  }
}

export class ProtectedCategoryKindError extends Error {
  constructor(readonly categoryId: number) {
    super(`"Uncategorized" is a protected category and its kind cannot be changed.`);
    this.name = "ProtectedCategoryKindError";
  }
}

export type SetCategoryKindResult = {
  categoryId: number;
  previousKind: CategoryKind;
  newKind: CategoryKind;
};

/**
 * D9A + X1: change a category's `kind`.
 *
 * A category with any transaction or `budget_periods` row is "used" and
 * refuses outright — reclassifying it retroactively rewrites every past
 * month's summary, the trend chart, goal inclusion, and categorize
 * eligibility, a blast radius no confirmation dialog can honestly enumerate.
 *
 * X1's one exception: expense → income on a category with at least one
 * transaction, all of them positive. That is the F1 failure mode's repair
 * path (a renamed income category, full of paychecks, that D9A would
 * otherwise refuse to fix forever) — decidable by one query rather than a
 * judgment call, and every OTHER transition stays absolute. A category
 * that is "used" only via a `budget_periods` row (planned, never spent) does
 * not fit that repair story and stays refused — `count > 0` is required,
 * not just "no negative rows found."
 *
 * A category can be X1-eligible AND have `budget_periods` rows (it was
 * actively budgeted under its wrong kind) — this function's own rule still
 * permits it: refusing it would leave the repair permanently incomplete for
 * exactly the categories most in need of it, since every month it was
 * budgeted while mislabeled would keep miscounting forever. The reclassify
 * PICKER (`loadReclassifyCandidates`) is more conservative than this
 * function on purpose, though: it excludes any category with a
 * `budget_periods` row from the candidate list entirely (DS32 — offering a
 * category whose reclassification would silently move months of allocated
 * spending into planned income, with no way to preview the blast radius in
 * the confirmation dialog, is exactly the "discovered only after a refused
 * submit" case DS32 exists to prevent, even though this function itself
 * would allow the submit to succeed). A future caller reaching this
 * function directly with such a category still gets the permissive
 * behavior described above.
 */
export function setCategoryKind(
  db: Db,
  categoryId: number,
  newKind: CategoryKind,
  opts: {
    /**
     * The caller showed the user the irreversibility confirmation and they
     * accepted. Required ONLY when the change takes the X1 branch; ignored
     * otherwise, because every other permitted transition is on an unused
     * category and freely reversible. See
     * `UnconfirmedIrreversibleKindChangeError`.
     */
    confirmedIrreversible?: boolean;
  } = {},
): SetCategoryKindResult {
  return db.transaction((tx) => {
    const category = tx
      .select({ id: schema.categories.id, name: schema.categories.name, kind: schema.categories.kind })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .get();
    if (!category) throw new CategoryNotFoundError(categoryId);
    if (category.name === "Uncategorized") throw new ProtectedCategoryKindError(categoryId);

    const previousKind = category.kind;
    if (previousKind === newKind) {
      return { categoryId, previousKind, newKind };
    }

    const txnStats = tx
      .select({
        count: sql<number>`COUNT(*)`,
        negativeCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.transactions.amountCents} < 0 THEN 1 ELSE 0 END), 0)`,
        earliestDate: sql<string | null>`MIN(${schema.transactions.date})`,
        latestDate: sql<string | null>`MAX(${schema.transactions.date})`,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.categoryId, categoryId))
      .get()!;

    const periodCount =
      tx
        .select({ count: sql<number>`COUNT(*)` })
        .from(schema.budgetPeriods)
        .where(eq(schema.budgetPeriods.categoryId, categoryId))
        .get()?.count ?? 0;

    // Rule 8's `isUsed` + X1 live in `assignableKinds` (categoryKindLock.ts),
    // not inline here, because `loadMonthView` has to answer the same question
    // to render an honest `CategoryMenu`. They were one spelling in one place
    // until the FUNDS band became editable and gave a fund a write path to a
    // `budget_periods` row — after which the menu kept offering a kind change
    // this function always refused (DS32).
    const allowed = assignableKinds(previousKind, {
      txnCount: txnStats.count,
      negativeTxnCount: txnStats.negativeCount,
      periodCount,
    });
    if (!allowed.includes(newKind)) {
      throw new CategoryKindChangeRefusedError(
        category.id,
        category.name,
        txnStats.count,
        txnStats.earliestDate,
        txnStats.latestDate,
      );
    }

    // The change is permitted. Is it the ONE-WAY one? `assignableKinds`
    // returns all three kinds iff the category is unused, so a permitted
    // change on a used category is X1 by construction — the same reading
    // `kindsImplyUsed` gives the client, checked here where it cannot be
    // stale.
    const isIrreversible = isCategoryUsed({
      txnCount: txnStats.count,
      negativeTxnCount: txnStats.negativeCount,
      periodCount,
    });
    if (isIrreversible && opts.confirmedIrreversible !== true) {
      throw new UnconfirmedIrreversibleKindChangeError(category.id, category.name);
    }

    // Dual-write (T5, D1B/A2): `createGoalAction` already keeps
    // `is_savings_goal` truthful alongside `kind` "until PR3 drops the
    // column entirely" (its own comment). PR2b's general `setCategoryKind`
    // (T25) is the other place `kind` can now change post-creation — without
    // this, reclassifying any category to/from `fund` through the `⋯` menu
    // would silently diverge the two columns the moment anything besides
    // `createGoalAction` reads `is_savings_goal` again.
    tx.update(schema.categories)
      .set({ kind: newKind, isSavingsGoal: newKind === "fund" })
      .where(eq(schema.categories.id, categoryId))
      .run();

    // Kind decides rollover eligibility (T2's income guard) and Left to
    // Budget's math. That used to require invalidating a cached
    // `effective_allocation_cents` forward from this category's earliest
    // `budget_periods` row; the cache is gone and every reader recomputes,
    // so the change takes effect on the next read with nothing to clear.

    return { categoryId, previousKind, newKind };
  });
}
