import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import { parseIsoMonth } from "@/lib/budget/monthOfIso";
import type { CategorizeTransactionSnapshot } from "./categorizeTransaction";

type Db = typeof defaultDb;

export type UndoCategorizeTransactionResult = {
  /** True when the target row was reverted to its prior category (or NULL). */
  targetReverted: boolean;
  /** Rows actually reset to NULL from the applyToPast set. */
  revertedApplyToPastCount: number;
  /** Rule action taken: "deleted" (insert undone), "restored" (prior row restored), "none". */
  ruleAction: "none" | "deleted" | "restored";
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
 * Rule: deleted if inserted; restored verbatim if replaced (full column
 * snapshot). `ruleTouched=false` → no-op.
 *
 * Invalidation: both categories get invalidated at their respective earliest
 * months. New category at earliest(target.date, earliestApplyToPastDate);
 * prior category (if non-null) at target.date month.
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

    let ruleAction: UndoCategorizeTransactionResult["ruleAction"] = "none";

    if (snapshot.ruleTouched) {
      if (snapshot.priorRule === null) {
        tx.delete(schema.categoryRules)
          .where(
            and(
              eq(schema.categoryRules.matchType, "exact"),
              eq(schema.categoryRules.matchValue, snapshot.normalizedMerchant),
              eq(schema.categoryRules.categoryId, snapshot.newCategoryId),
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

    const newCatEarliest = earlierDate(
      snapshot.targetDate,
      snapshot.earliestApplyToPastDate,
    );
    const { year: newYear, month: newMonth } = parseIsoMonth(newCatEarliest);
    invalidateForwardRollover(tx, snapshot.newCategoryId, newYear, newMonth);

    if (snapshot.targetPriorCategoryId !== null) {
      const { year: priorYear, month: priorMonth } = parseIsoMonth(
        snapshot.targetDate,
      );
      invalidateForwardRollover(
        tx,
        snapshot.targetPriorCategoryId,
        priorYear,
        priorMonth,
      );
    }

    return { targetReverted, revertedApplyToPastCount, ruleAction };
  });
}

function earlierDate(a: string, b: string | null): string {
  if (b === null) return a;
  return a < b ? a : b;
}
