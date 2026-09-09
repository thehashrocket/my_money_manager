import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import type { BulkRetargetSnapshot } from "./bulkRetarget";
import { restorePriorRule } from "./restorePriorRule";
import type { RuleUndoAction } from "./undoBulkCategorize";

type Db = typeof defaultDb;

export type UndoBulkRetargetResult = {
  /**
   * Rows actually moved back. May be fewer than `snapshot.txnIds.length` when
   * the user re-categorized some of them inside the undo window — those are
   * left alone rather than stomped.
   */
  revertedCount: number;
  /** What happened to the rule: inserted → deleted, updated/removed → restored. */
  ruleAction: RuleUndoAction;
};

/**
 * Reverse a {@link BulkRetargetSnapshot} — put the moved rows back under
 * `fromCategoryId`.
 *
 * Transactions: only rows still pointing at `snapshot.categoryId` are moved
 * back, the same stale-row guard `undoBulkCategorize` and
 * `undoCategorizeTransaction` use. The difference from those two is only the
 * destination: they reset to a constant (`null`, or the target's single prior
 * category), and this resets to `snapshot.fromCategoryId` — which is a
 * constant too, because the row set was DEFINED by that category. See
 * `BulkRetargetSnapshot.txnIds` for why that is a property of the design and
 * not a lucky simplification.
 *
 * Rules: identical to `undoBulkCategorize`'s three cases, and deliberately so
 * — inserted → delete by primary key (reporting `"already-gone"` when someone
 * else got there first), prior → `restorePriorRule` verbatim, untouched →
 * no-op.
 *
 * Rollover: spend moves back across the same boundary it crossed, so the same
 * two chains recompute on their next read. Migration 0021 removed the cache
 * this used to invalidate for both.
 *
 * Not idempotent in the "run it twice" sense, and it does not need to be: the
 * second run finds no row still at `snapshot.categoryId`, reverts 0, and the
 * rule branch is the only part that could act twice — `restorePriorRule` is
 * itself a restore-to-a-known-row, so it converges.
 */
export function undoBulkRetarget(
  db: Db,
  snapshot: BulkRetargetSnapshot,
): UndoBulkRetargetResult {
  return db.transaction((tx) => {
    let revertedCount = 0;

    if (snapshot.txnIds.length > 0) {
      const result = tx
        .update(schema.transactions)
        .set({ categoryId: snapshot.fromCategoryId, updatedAt: new Date() })
        /* The merchant condition is not redundant with the id list — it is
           what bounds a CRAFTED snapshot. Every field here round-trips
           through the browser, and unlike the forward path this one runs no
           `assertAssignableCategory` (it deliberately cannot: `bulkRetarget`
           allows an archived/fund/parent SOURCE, so a legitimate undo has to
           be able to restore into one). Without this clause a hand-edited
           payload moves any rows filed under any category into any other,
           including the three the forward guard refuses. Keying on the
           merchant the snapshot already carries costs nothing and confines
           the blast radius to one merchant key. */
        .where(
          and(
            inArray(schema.transactions.id, snapshot.txnIds),
            eq(schema.transactions.categoryId, snapshot.categoryId),
            eq(
              schema.transactions.normalizedMerchant,
              snapshot.normalizedMerchant,
            ),
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

    return { revertedCount, ruleAction };
  });
}
