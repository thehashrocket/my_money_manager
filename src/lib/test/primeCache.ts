import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { getEffectiveAllocation } from "@/lib/budget";
import type { AnyDb } from "@/db";

/**
 * TS1 deleted `getEffectiveAllocation`'s `persist` option (T8) — tests that
 * need a pre-existing cached `effective_allocation_cents` value, to prove a
 * later call actually clears it, now write it directly instead. Only writes
 * the target month, not the whole recursive chain the old `persist: true`
 * cascaded through — callers that relied on the cascade prime each month
 * they need explicitly.
 */
export function primeCache(db: AnyDb, categoryId: number, year: number, month: number) {
  const computed = getEffectiveAllocation(db, categoryId, year, month);
  if (computed) {
    db.update(schema.budgetPeriods)
      .set({ effectiveAllocationCents: computed.effectiveCents })
      .where(
        and(
          eq(schema.budgetPeriods.categoryId, categoryId),
          eq(schema.budgetPeriods.year, year),
          eq(schema.budgetPeriods.month, month),
        ),
      )
      .run();
  }
  return computed;
}
