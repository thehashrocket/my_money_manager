import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { getEffectiveAllocation, invalidateForwardRollover, type EffectiveAllocation } from "@/lib/budget";
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
 * `allocated_cents`. Nothing rebuilds the cache column, though (T8/TS1
 * deleted the only writer, `getEffectiveAllocation`'s `persist` option) — it
 * just stays NULL, which every real reader (`loadMonthView`'s set-based
 * path) already ignores. See `invalidateForwardRollover`'s own docstring in
 * `budget.ts`.
 *
 * P2 (T18): returns the reconciled row — `getEffectiveAllocation`, read
 * inside the same transaction right after the invalidation it depends on —
 * so `<MonthEditor>`'s inline commit can merge the real
 * allocated/rollover/effective triple back into client state instead of
 * trusting its own optimistic guess (which cannot know a rollover
 * category's carried-forward balance) or re-fetching the whole route.
 */
export function upsertAllocation(db: Db, input: AllocateInput): EffectiveAllocation {
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

  return db.transaction((tx) => {
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

    // The row we just wrote always exists at this point — `reconciled` can
    // only be null when no `budget_periods` row exists for the month, which
    // the insert above just guaranteed.
    const reconciled = getEffectiveAllocation(tx, categoryId, year, month);
    if (!reconciled) {
      throw new Error(`upsertAllocation: reconciled row missing for category ${categoryId} ${year}-${month}`);
    }
    return reconciled;
  });
}
