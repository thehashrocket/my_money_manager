import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import type { BulkCategorizeSnapshot } from "./bulkCategorize";

type Db = typeof defaultDb;

export type UndoResult = {
  /** Rows actually reset to NULL (may be < snapshot.txnIds.length if the user
   *  re-categorized some rows in the meantime). */
  revertedCount: number;
  /** What happened to the rule: inserted → deleted, updated → restored, none → nothing. */
  ruleAction: "none" | "deleted" | "restored";
};

/**
 * Reverse a {@link BulkCategorizeSnapshot}.
 *
 * Transactions: only rows still pointing at `snapshot.categoryId` (from the
 * snapshot's `txnIds`) get reset to `NULL`. Rows the user re-categorized after
 * the fact are left alone — we don't overwrite work done post-snapshot.
 *
 * Rules (C3):
 * - `priorRule = null` + `ruleTouched = true` → the bulk inserted a rule; delete it.
 * - `priorRule != null` + `ruleTouched = true` → restore the full prior row
 *   (categoryId, priority, source, matchType, matchValue, createdAt, updatedAt)
 *   verbatim via UPDATE on the prior row's primary key.
 * - `ruleTouched = false` → no-op on rules.
 *
 * Invalidation: the same earliest-month invalidation that `bulkCategorize`
 * wrote is re-run against `snapshot.categoryId`. Spend just changed back, so
 * every downstream rollover row for that category must recompute. We do not
 * need to invalidate a second category because the pre-bulk state was NULL.
 */
export function undoBulkCategorize(
  db: Db,
  snapshot: BulkCategorizeSnapshot,
): UndoResult {
  return db.transaction((tx) => {
    let revertedCount = 0;

    if (snapshot.txnIds.length > 0) {
      const result = tx
        .update(schema.transactions)
        .set({ categoryId: null, updatedAt: new Date() })
        .where(
          and(
            inArray(schema.transactions.id, snapshot.txnIds),
            eq(schema.transactions.categoryId, snapshot.categoryId),
          ),
        )
        .returning({ id: schema.transactions.id })
        .all();
      revertedCount = result.length;
    }

    let ruleAction: UndoResult["ruleAction"] = "none";

    if (snapshot.ruleTouched) {
      if (snapshot.priorRule === null) {
        tx.delete(schema.categoryRules)
          .where(
            and(
              eq(schema.categoryRules.matchType, "exact"),
              eq(schema.categoryRules.matchValue, snapshot.normalizedMerchant),
              eq(schema.categoryRules.categoryId, snapshot.categoryId),
            ),
          )
          .run();
        ruleAction = "deleted";
      } else {
        const prior = snapshot.priorRule;
        tx.update(schema.categoryRules)
          .set({
            categoryId: prior.categoryId,
            matchType: prior.matchType,
            matchValue: prior.matchValue,
            priority: prior.priority,
            source: prior.source,
            createdAt: prior.createdAt,
            updatedAt: prior.updatedAt,
          })
          .where(eq(schema.categoryRules.id, prior.id))
          .run();
        ruleAction = "restored";
      }
    }

    if (snapshot.earliestDate) {
      const year = Number(snapshot.earliestDate.slice(0, 4));
      const month = Number(snapshot.earliestDate.slice(5, 7));
      invalidateForwardRollover(tx, snapshot.categoryId, year, month);
    }

    return { revertedCount, ruleAction };
  });
}
