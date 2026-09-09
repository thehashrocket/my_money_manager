import { eq } from "drizzle-orm";
import { schema, type AnyDb } from "@/db";
import {
  CategoryArchivedError,
  CategoryNotFoundError,
  ParentAllocationError,
  SavingsGoalCategoryError,
} from "@/lib/categoryErrors";

/** The destination category, once it has been cleared to receive rows. */
export type AssignableCategory = { id: number; name: string };

/**
 * "May a transaction be filed under this category?" — the one spelling.
 *
 * `bulkCategorize` and `categorizeTransaction` each carried a hand-maintained
 * copy of these four checks in this exact order, and `bulkRetarget` would have
 * made three. They are all DEFENSIVE rather than decorative: `CategoryCombobox`
 * already filters parents, funds and archived categories out of the picker, so
 * every one of these only fires on input the UI could not have produced — a
 * stale tab loaded before an archive, a second tab, or a crafted post. That is
 * precisely the class of check that must not be allowed to drift between
 * callers, because nothing in ordinary use would ever reveal that one of them
 * had lost a branch.
 *
 * Takes the handle rather than opening its own: `categorizeTransaction` runs
 * these inside its write transaction and `bulkCategorize` runs them on `db`
 * before opening one. Both placements stay valid — the checks are reads.
 *
 * Order is load-bearing in one place only, and it is the reason `kind` is
 * tested before `archivedAt`: an archived fund should report as a fund, since
 * unarchiving it (what `CategoryArchivedError` tells you to do) would not make
 * it assignable.
 */
export function assertAssignableCategory(
  tx: AnyDb,
  categoryId: number,
): AssignableCategory {
  const category = tx
    .select({
      id: schema.categories.id,
      name: schema.categories.name,
      kind: schema.categories.kind,
      archivedAt: schema.categories.archivedAt,
    })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!category) throw new CategoryNotFoundError(categoryId);
  // A2: kind is authoritative, not is_savings_goal (T5).
  if (category.kind === "fund") {
    throw new SavingsGoalCategoryError(category.id, category.name);
  }
  if (category.archivedAt !== null) {
    throw new CategoryArchivedError(category.id, category.name);
  }

  const firstChild = tx
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.parentId, categoryId))
    .limit(1)
    .get();
  if (firstChild) throw new ParentAllocationError(category.id, category.name);

  return { id: category.id, name: category.name };
}
