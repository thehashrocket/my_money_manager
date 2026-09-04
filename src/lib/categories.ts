import { and, eq, isNull, ne, notInArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";

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
 * `{ includeArchived: true }` explicitly; the option shape mirrors
 * `getEffectiveAllocation`'s "read what's there, no persist-side-effect"
 * posture rather than introducing a second function.
 *
 * Sort: by name ASC. Two SELECTs is fine at V1 scale (dozens of categories)
 * and keeps the query readable; can fold into one query if it ever matters.
 */
export function listLeafCategories(db: Db, options: { includeArchived?: boolean } = {}): LeafCategory[] {
  const { includeArchived = false } = options;
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
