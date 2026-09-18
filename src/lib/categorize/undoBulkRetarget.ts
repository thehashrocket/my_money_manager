import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import type { BulkRetargetSnapshot } from "./bulkRetarget";
import { restorePriorRule } from "./restorePriorRule";
import type { RuleUndoAction } from "./undoBulkCategorize";

type Db = typeof defaultDb;

export type UndoBulkRetargetResult =
  | {
      /** No rows were reverted — every one was re-categorized by the user
       *  inside the undo window. There is nothing to say about a restore
       *  destination, so the type doesn't offer one. */
      anyReverted: false;
      revertedCount: 0;
      /** What happened to the rule: inserted → deleted, updated/removed → restored. */
      ruleAction: RuleUndoAction;
    }
  | {
      anyReverted: true;
      /** Rows actually moved back. May be fewer than
       *  `snapshot.txnIds.length` when the user re-categorized some of them
       *  inside the undo window — those are left alone rather than stomped. */
      revertedCount: number;
      /**
       * What every reverted row was ACTUALLY restored to. Callers must
       * render THIS, never `snapshot.fromCategoryId` directly: `fromCategoryId`
       * is always a real category, so `null` here is unambiguous — it means
       * `fromCategoryBecameFund` is true, never "the prior category was
       * null" (unlike the single-row `undoCategorizeTransaction`, a
       * retarget's source is never null to begin with).
       */
      restoredCategoryId: number | null;
      /**
       * True when `snapshot.fromCategoryId` has been reclassified to
       * `kind='fund'` SINCE the forward `bulkRetarget` call — checked fresh
       * here, not trusted from the snapshot. `bulkRetarget` deliberately
       * allows a fund as a retarget SOURCE (draining rows already filed to
       * one), and this function used to restore into `fromCategoryId`
       * unconditionally on that theory. What it missed: a category that was
       * an ordinary `expense`/`income` at retarget time can become unused
       * the moment its rows move away, and an unused category is freely
       * reclassifiable with no confirmation (rule 8) — so the category
       * could become a fund entirely WITHIN the 10s undo window, and
       * restoring into it then would create fresh fund transactions, not
       * drain pre-existing ones. Falls back to `null` in that case.
       */
      fromCategoryBecameFund: boolean;
      /** What happened to the rule: inserted → deleted, updated/removed → restored. */
      ruleAction: RuleUndoAction;
    };

/**
 * Reverse a {@link BulkRetargetSnapshot} — put the moved rows back under
 * `fromCategoryId`, UNLESS that category has become a fund since the forward
 * call (checked fresh here — rule 11), in which case they fall back to
 * `null` instead. See {@link UndoBulkRetargetResult.fromCategoryBecameFund}
 * for why: an outside review found this reachable through ordinary use, not
 * a crafted input, and it is the exact bug class this whole release exists
 * to close — see DESIGN.md's "What a fund's progress means".
 *
 * Transactions: only rows still pointing at `snapshot.categoryId` are moved
 * back, the same stale-row guard `undoBulkCategorize` and
 * `undoCategorizeTransaction` use. The difference from those two is only the
 * destination: they reset to a constant (`null`, or the target's single prior
 * category), and this resets to a constant too — `snapshot.fromCategoryId`,
 * or `null` on the fund fallback — because the row set was DEFINED by that
 * category. See `BulkRetargetSnapshot.txnIds` for why that is a property of
 * the design and not a lucky simplification.
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
    // Rule 11: read `fromCategoryId`'s CURRENT kind inside this same write
    // transaction, not trusted from the snapshot's moment. `bulkRetarget`
    // applies no kind guard to its SOURCE (rows moving off a fund are the
    // point), and moving a category's only rows away can leave it unused —
    // which `assignableKinds` (rule 8) then lets be reclassified to `fund`
    // with zero confirmation, entirely inside the 10s undo window.
    const fromCategoryBecameFund =
      tx
        .select({ kind: schema.categories.kind })
        .from(schema.categories)
        .where(eq(schema.categories.id, snapshot.fromCategoryId))
        .get()?.kind === "fund";
    const restoreCategoryId = fromCategoryBecameFund
      ? null
      : snapshot.fromCategoryId;

    let revertedCount = 0;

    if (snapshot.txnIds.length > 0) {
      const result = tx
        .update(schema.transactions)
        .set({ categoryId: restoreCategoryId, updatedAt: new Date() })
        /* The merchant condition is not redundant with the id list — it is
           what bounds a CRAFTED snapshot. Every field here round-trips
           through the browser, and unlike the forward path this one runs no
           `assertAssignableCategory` (it deliberately cannot: `bulkRetarget`
           allows an archived/parent SOURCE, so a legitimate undo has to be
           able to restore into one — a fund source is handled above instead,
           since a legitimate one and a freshly-raced one are indistinguishable
           without the fresh kind check). Without this clause a hand-edited
           payload moves any rows filed under any category into any other,
           including the two the forward guard still refuses. Keying on the
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

    if (revertedCount === 0) {
      return { anyReverted: false, revertedCount: 0, ruleAction };
    }
    return {
      anyReverted: true,
      revertedCount,
      restoredCategoryId: restoreCategoryId,
      fromCategoryBecameFund,
      ruleAction,
    };
  });
}
