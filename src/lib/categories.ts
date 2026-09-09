import { and, eq, isNull, ne, notInArray } from "drizzle-orm";
import { db as defaultDb, schema, type AnyDb } from "@/db";

type Db = typeof defaultDb;

export type LeafCategory = {
  id: number;
  name: string;
  parentId: number | null;
};

/**
 * Leaf = any category that no other category references as a parent,
 * excluding savings-goal categories. The `/categorize` dropdown only shows
 * these; bulk categorize refuses anything else (parents are header-only;
 * savings goals live on a separate surface).
 *
 * X3/B7: `includeArchived` defaults to `false` — a picker (this dropdown,
 * `CategoryCombobox`) must never let you re-file a transaction into an
 * archived category. But `/transactions` also uses this same list to resolve
 * an ALREADY-categorized row's display label, and excluding archived there
 * makes that lookup return nothing — the row's own category name goes
 * blank. Callers doing label resolution over historical data must pass
 * `{ includeArchived: true }` explicitly, rather than reaching for a second
 * function that differs only in one WHERE clause.
 *
 * Sort: by name ASC. Two SELECTs is fine at V1 scale (dozens of categories)
 * and keeps the query readable; can fold into one query if it ever matters.
 */
export function listLeafCategories(
  db: Db,
  options: { includeArchived?: boolean; excludeIncome?: boolean } = {},
): LeafCategory[] {
  const { includeArchived = false, excludeIncome = false } = options;
  const parentRows = db
    .selectDistinct({ parentId: schema.categories.parentId })
    .from(schema.categories)
    .all();
  const parentIds = parentRows
    .map((r) => r.parentId)
    .filter((id): id is number => id !== null);

  const conditions = [
    // A2: kind is authoritative, not is_savings_goal (T5).
    ne(schema.categories.kind, "fund"),
    ...(parentIds.length > 0 ? [notInArray(schema.categories.id, parentIds)] : []),
    ...(includeArchived ? [] : [isNull(schema.categories.archivedAt)]),
    // Opt-in, and only `/accounts`' charge dialog asks for it. A hand-entered
    // card charge is spending, so an income category is never a valid
    // destination — filing an $80 charge under "Paycheck" writes -8000 into
    // income and silently reduces that month's `leftToBudgetCents`. Left OUT
    // of the default so `/categorize`'s picker, which legitimately files
    // deposits, is unaffected. The server-side twin is
    // `checkChargeableCategory`; this only stops the UI offering an option
    // that would be refused.
    ...(excludeIncome ? [ne(schema.categories.kind, "income")] : []),
  ];

  const rows = db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
    })
    .from(schema.categories)
    .where(and(...conditions))
    .all();

  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

export type ChargeableRefusal = "not-found" | "archived" | "parent" | "fund" | "income";

export type ChargeableCheck =
  | { ok: true; name: string }
  | { ok: false; reason: ChargeableRefusal; name: string | null };

/**
 * Can a hand-entered card charge be filed under this category?
 *
 * The third write path took `categoryId` on trust — `Number.isInteger(id) &&
 * id > 0` in the action, then straight into the INSERT. `categorizeTransaction`
 * and `bulkCategorize` both resolve and classify the category first; this is
 * the same gate for the path that skipped it. Five ways a syntactically valid
 * id is still wrong, and only the first is loud:
 *
 *   not-found  the FK fires, so this at least failed — but as a raw
 *              "FOREIGN KEY constraint failed" through the action's blanket
 *              catch, which is unactionable and violates the module's own
 *              "nothing throws for a reachable outcome" contract (E20).
 *   archived   rule 8 excludes an archived category from every picker; a stale
 *              tab plus an archive in another tab lands a charge in one anyway.
 *   parent     parents are header-only. `loadMonthView` renders them as section
 *              headers, so the spend exists in the ledger, belongs to no
 *              envelope, and is invisible in the budget — the exact outcome
 *              D13=B exists to prevent.
 *   fund       savings goals live on their own surface; `bulkCategorize`
 *              refuses these outright.
 *   income     needs no adversary at all. Income leaves were in the charge
 *              dialog's own picker, so filing an $80 charge under "Paycheck"
 *              wrote -8000 into an income category and quietly reduced that
 *              month's income and `leftToBudgetCents`.
 *
 * Takes `AnyDb` so it can run INSIDE the caller's write transaction rather
 * than in a separate read before it — a category archived between the check
 * and the insert would otherwise slip through.
 */
export function checkChargeableCategory(db: AnyDb, categoryId: number): ChargeableCheck {
  const cat = db
    .select({
      name: schema.categories.name,
      kind: schema.categories.kind,
      archivedAt: schema.categories.archivedAt,
    })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!cat) return { ok: false, reason: "not-found", name: null };

  if (cat.archivedAt !== null) return { ok: false, reason: "archived", name: cat.name };
  if (cat.kind === "fund") return { ok: false, reason: "fund", name: cat.name };
  if (cat.kind === "income") return { ok: false, reason: "income", name: cat.name };

  const firstChild = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.parentId, categoryId))
    .limit(1)
    .get();
  if (firstChild) return { ok: false, reason: "parent", name: cat.name };

  return { ok: true, name: cat.name };
}

export type LeafLookup = {
  isLeaf: boolean;
  isSavingsGoal: boolean;
  name: string;
};

/**
 * Classify a single category by id. Returns `null` if the row doesn't exist
 * (the caller handles that via `CategoryNotFoundError`). `isLeaf` is `true`
 * only when no other category lists this one as a parent.
 */
export function classifyCategory(db: Db, categoryId: number): LeafLookup | null {
  const cat = db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      isSavingsGoal: schema.categories.isSavingsGoal,
    })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!cat) return null;

  const firstChild = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.parentId, categoryId))
    .limit(1)
    .get();

  return {
    name: cat.name,
    isSavingsGoal: cat.isSavingsGoal,
    isLeaf: !firstChild,
  };
}
