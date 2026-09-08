import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import type { BulkCategorizeSnapshot } from "./bulkCategorize";
import { restorePriorRule } from "./restorePriorRule";

type Db = typeof defaultDb;

/**
 * What an undo did to `category_rules`.
 *
 * `"already-gone"` is the honest answer for "we went to delete the rule this
 * call inserted and it was not there any more" — someone else removed or
 * retargeted it inside the 10s window. It used to report `"deleted"`
 * unconditionally, which made a no-op indistinguishable from a success at the
 * one moment the user is checking whether their rule came back.
 */
export type RuleUndoAction = "none" | "deleted" | "already-gone" | "restored";

export type UndoResult = {
  /** Rows actually reset to NULL (may be < snapshot.txnIds.length if the user
   *  re-categorized some rows in the meantime). */
  revertedCount: number;
  /** What happened to the rule: inserted → deleted, updated/removed → restored. */
  ruleAction: RuleUndoAction;
};

/**
 * Reverse a {@link BulkCategorizeSnapshot}.
 *
 * Transactions: only rows still pointing at `snapshot.categoryId` (from the
 * snapshot's `txnIds`) get reset to `NULL`. Rows the user re-categorized after
 * the fact are left alone — we don't overwrite work done post-snapshot.
 *
 * Rules (C3):
 * - `priorRule = null` + `ruleTouched = true` → the bulk inserted a rule; delete
 *   it by primary key, and report `"already-gone"` if it was not there.
 * - `priorRule != null` + `ruleTouched = true` → restore the full prior row
 *   verbatim (see {@link restorePriorRule}). Covers BOTH ways a prior rule can
 *   be gone: overwritten by the upsert, or deleted by a trainability refusal.
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

    let ruleAction: RuleUndoAction = "none";

    if (snapshot.ruleTouched) {
      if (snapshot.priorRule === null) {
        if (snapshot.insertedRuleId !== null) {
          const removed = tx
            .delete(schema.categoryRules)
            .where(eq(schema.categoryRules.id, snapshot.insertedRuleId))
            .returning({ id: schema.categoryRules.id })
            .all();
          ruleAction = removed.length > 0 ? "deleted" : "already-gone";
        }
      } else {
        restorePriorRule(tx, snapshot.priorRule);
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
