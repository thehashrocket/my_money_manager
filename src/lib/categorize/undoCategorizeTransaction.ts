import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import type { CategorizeTransactionSnapshot } from "./categorizeTransaction";
import { restorePriorRule } from "./restorePriorRule";
import type { RuleUndoAction } from "./undoBulkCategorize";

type Db = typeof defaultDb;

export type UndoCategorizeTransactionResult = {
  /** True when the target row was reverted to its prior category (or NULL). */
  targetReverted: boolean;
  /** Rows actually reset to NULL from the applyToPast set. */
  revertedApplyToPastCount: number;
  /** Rule action taken — see {@link RuleUndoAction}. */
  ruleAction: RuleUndoAction;
};

/**
 * Reverse a {@link CategorizeTransactionSnapshot}.
 *
 * Target row: reset to `targetPriorCategoryId` (may be null). Guard: only if
 * the row still points at `newCategoryId` — if the user re-categorized after
 * the apply, we leave their work alone (symmetry with bulk undo).
 *
 * Apply-to-past rows: reset to NULL, but only rows still pointing at
 * `newCategoryId` (same guard — user re-touch wins).
 *
 * Rule: deleted if this call inserted it; restored verbatim if it was
 * overwritten OR deleted by a trainability refusal (full column snapshot, see
 * {@link restorePriorRule}). `ruleTouched=false` → no-op.
 *
 * The delete is by primary key via `snapshot.insertedRuleId`. It used to match
 * on (match_type, match_value, category_id) and assert `"deleted"` without
 * checking, which is unsafe the moment a second writer can retarget that row
 * inside the 10s window — `/subscriptions` upserts arbitrary keys to
 * `Subscriptions` with no UI in front of it. The old lookup then matched
 * nothing, the rule survived, and the undo still said it had gone.
 *
 * Rollover: spend moves back across the same boundary it crossed, and both
 * categories' downstream months reflect that on their next read — migration
 * 0021 removed the cache this used to invalidate.
 */
export function undoCategorizeTransaction(
  db: Db,
  snapshot: CategorizeTransactionSnapshot,
): UndoCategorizeTransactionResult {
  return db.transaction((tx) => {
    const targetResult = tx
      .update(schema.transactions)
      .set({ categoryId: snapshot.targetPriorCategoryId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.transactions.id, snapshot.targetTxnId),
          eq(schema.transactions.categoryId, snapshot.newCategoryId),
        ),
      )
      .returning({ id: schema.transactions.id })
      .all();
    const targetReverted = targetResult.length > 0;

    let revertedApplyToPastCount = 0;
    if (snapshot.applyToPastTxnIds.length > 0) {
      const result = tx
        .update(schema.transactions)
        .set({ categoryId: null, updatedAt: new Date() })
        .where(
          and(
            inArray(schema.transactions.id, snapshot.applyToPastTxnIds),
            eq(schema.transactions.categoryId, snapshot.newCategoryId),
          ),
        )
        .returning({ id: schema.transactions.id })
        .all();
      revertedApplyToPastCount = result.length;
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

    return { targetReverted, revertedApplyToPastCount, ruleAction };
  });
}

