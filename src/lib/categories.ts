import { and, eq, notInArray } from "drizzle-orm";
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
 * Sort: by name ASC. Two SELECTs is fine at V1 scale (dozens of categories)
 * and keeps the query readable; can fold into one query if it ever matters.
 */
export function listLeafCategories(db: Db): LeafCategory[] {
  const parentRows = db
    .selectDistinct({ parentId: schema.categories.parentId })
    .from(schema.categories)
    .all();
  const parentIds = parentRows
    .map((r) => r.parentId)
    .filter((id): id is number => id !== null);

  const rows = db
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
    })
    .from(schema.categories)
    .where(
      parentIds.length > 0
        ? and(
            eq(schema.categories.isSavingsGoal, false),
            notInArray(schema.categories.id, parentIds),
          )
        : eq(schema.categories.isSavingsGoal, false),
    )
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
