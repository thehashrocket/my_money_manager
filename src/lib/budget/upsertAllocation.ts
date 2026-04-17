import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import {
  CategoryNotFoundError,
  ParentAllocationError,
} from "@/lib/categoryErrors";
import type { AllocateInput } from "./validateAllocateInput";

type Db = typeof defaultDb;

export { CategoryNotFoundError, ParentAllocationError };

/**
 * Upsert a single `budget_periods` row (unique on `category_id, year, month`)
 * and clear cached `effective_allocation_cents` for that row plus every
 * downstream rollover month for the same category.
 *
 * DB-bound invariants enforced here (the pure `validateAllocateInput` has
 * already checked the shape/range):
 * - Category must exist.
 * - Parent categories (those referenced by at least one child's `parent_id`)
 *   are header-only and reject allocations.
 *
 * Upsert + invalidation run inside a single `db.transaction` so an error
 * between steps never leaves a stale cache pointing at a mutated
 * `allocated_cents`. The cache rebuilds lazily on the next read.
 */
export function upsertAllocation(db: Db, input: AllocateInput): void {
  const { categoryId, year, month, allocatedCents } = input;

  const category = db
    .select({ id: schema.categories.id, name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!category) throw new CategoryNotFoundError(categoryId);

  const firstChild = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.parentId, categoryId))
    .limit(1)
    .get();
  if (firstChild) throw new ParentAllocationError(category.id, category.name);

  db.transaction((tx) => {
    tx.insert(schema.budgetPeriods)
      .values({ categoryId, year, month, allocatedCents })
      .onConflictDoUpdate({
        target: [
          schema.budgetPeriods.categoryId,
          schema.budgetPeriods.year,
          schema.budgetPeriods.month,
        ],
        set: {
          allocatedCents,
          effectiveAllocationCents: null,
          updatedAt: new Date(),
        },
      })
      .run();
    invalidateForwardRollover(tx, categoryId, year, month);
  });
}
