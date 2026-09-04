import { db as defaultDb, schema } from "@/db";

type Db = typeof defaultDb;

export type CategoryListRow = {
  id: number;
  name: string;
  kind: "income" | "expense" | "fund";
  parentId: number | null;
  parentName: string | null;
  carryoverPolicy: "none" | "rollover" | "reset";
  archivedAt: Date | null;
  isGroup: boolean;
};

/**
 * DS20's `/budget/categories` — "the full management route." Unlike
 * `loadMonthView`, this is not month-scoped and does not hide archived rows
 * (X3's visibility rule is a per-MONTH concern; this route's entire job is
 * being the one place an archived category is still findable, since it's
 * the only surface `unarchiveCategoryAction` can be reached from once a
 * category drops out of every picker and month view).
 */
export function loadAllCategories(db: Db): CategoryListRow[] {
  const categories = db.select().from(schema.categories).all();
  const parentIds = new Set(categories.map((c) => c.parentId).filter((id): id is number => id !== null));
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  return categories
    .map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      parentId: c.parentId,
      parentName: c.parentId !== null ? (nameById.get(c.parentId) ?? null) : null,
      carryoverPolicy: c.carryoverPolicy,
      archivedAt: c.archivedAt,
      isGroup: parentIds.has(c.id),
    }))
    .sort((a, b) => {
      const kindDiff = a.kind.localeCompare(b.kind);
      if (kindDiff !== 0) return kindDiff;
      const parentDiff = (a.parentName ?? "").localeCompare(b.parentName ?? "");
      if (parentDiff !== 0) return parentDiff;
      return a.name.localeCompare(b.name);
    });
}
