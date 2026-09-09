import { eq } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { getEffectiveAllocation, type EffectiveAllocation } from "@/lib/budget";
import {
  CategoryArchivedError,
  CategoryNotFoundError,
  ParentAllocationError,
} from "@/lib/categoryErrors";
import type { AllocateInput } from "./validateAllocateInput";

type Db = typeof defaultDb;

export { CategoryArchivedError, CategoryNotFoundError, ParentAllocationError };

/**
 * Upsert a single `budget_periods` row (unique on `category_id, year, month`)
 * and return the reconciled allocation triple.
 *
 * Every downstream rollover month reflects the change on its next read —
 * `getEffectiveAllocation` and `computeEffectiveAllocationsForRollover` both
 * recompute from `allocated_cents` and spend. There is nothing to invalidate;
 * migration 0021 removed the cache this used to clear.
 *
 * DB-bound invariants enforced here (the pure `validateAllocateInput` has
 * already checked the shape/range):
 * - Category must exist.
 * - Category must not be archived (X3: the same stale-tab/second-tab gap
 *   `categorizeTransaction`/`bulkCategorize` close — a still-open
 *   `<MonthEditor>` tab can commit an allocation for a category archived
 *   from elsewhere mid-session, silently reviving it in the month view).
 * - Parent categories (those referenced by at least one child's `parent_id`)
 *   are header-only and reject allocations.
 *
 * The upsert and the read-back run inside a single `db.transaction` so the
 * value returned to the client is the one this call actually wrote, not a
 * figure a concurrent write could have moved in between. (It used to also
 * clear an `effective_allocation_cents` cache here; that column and its
 * invalidation contract are gone — `getEffectiveAllocation` always
 * recomputes now. See its docstring in `budget.ts`.)
 *
 * P2 (T18): returns the reconciled row — `getEffectiveAllocation`, read
 * inside the same transaction right after the write —
 * so `<MonthEditor>`'s inline commit can merge the real
 * allocated/rollover/effective triple back into client state instead of
 * trusting its own optimistic guess (which cannot know a rollover
 * category's carried-forward balance) or re-fetching the whole route.
 */
export function upsertAllocation(db: Db, input: AllocateInput): EffectiveAllocation {
  const { categoryId, year, month, allocatedCents } = input;

  const category = db
    .select({ id: schema.categories.id, name: schema.categories.name, archivedAt: schema.categories.archivedAt })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!category) throw new CategoryNotFoundError(categoryId);
  if (category.archivedAt !== null) throw new CategoryArchivedError(category.id, category.name);

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
          updatedAt: new Date(),
        },
      })
      .run();

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
