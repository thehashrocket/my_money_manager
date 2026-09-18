import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import type { CategorizeTransactionSnapshot } from "./categorizeTransaction";
import { restorePriorRule } from "./restorePriorRule";
import type { RuleUndoAction } from "./undoBulkCategorize";

type Db = typeof defaultDb;

export type UndoCategorizeTransactionResult =
  | {
      /** The target row was NOT reverted — the user re-categorized it to
       *  something else inside the undo window, so it was left alone. There
       *  is no restore destination to report. */
      targetReverted: false;
      /** Rows actually reset to NULL from the applyToPast set. */
      revertedApplyToPastCount: number;
      /** Rule action taken — see {@link RuleUndoAction}. */
      ruleAction: RuleUndoAction;
    }
  | {
      targetReverted: true;
      /**
       * What the target row was ACTUALLY reverted to. Callers must render
       * THIS, never `snapshot.targetPriorCategoryId` directly: the two can
       * disagree (see `priorCategoryBecameFund`), and this is the only field
       * that reflects what the write inside this transaction actually did.
       * A discriminated union rather than an optional field on purpose — an
       * earlier version made this `restoredCategoryId?: number | null` and
       * both an adversarial review and a type-design review independently
       * flagged the same footgun: `undo.restoredCategoryId ?? fallback`
       * type-checks and looks idiomatic (it's how this codebase spells a
       * default everywhere else) but silently collapses "restored to
       * nothing" into "nothing happened," which is wrong. Narrowing on
       * `targetReverted` first makes that misuse a compile error instead.
       */
      restoredCategoryId: number | null;
      /**
       * True when `snapshot.targetPriorCategoryId` pointed at a category that is
       * now `kind='fund'` — reclassified between the original categorize action
       * and this undo (an outside review's finding: two tabs, or two clicks in
       * quick succession, no crafted input needed). Restoring into it would
       * silently populate the one thing DESIGN.md documents as permanently
       * empty for a fund, so this undo falls back to `null` (uncategorized)
       * instead — the same "can't put it back exactly, land in the safe state"
       * behavior this file already gives a row someone else re-categorized
       * inside the undo window.
       */
      priorCategoryBecameFund: boolean;
      /** Rows actually reset to NULL from the applyToPast set. */
      revertedApplyToPastCount: number;
      /** Rule action taken — see {@link RuleUndoAction}. */
      ruleAction: RuleUndoAction;
    };

/**
 * Reverse a {@link CategorizeTransactionSnapshot}.
 *
 * Target row: reset to `targetPriorCategoryId` (may be null) — UNLESS that
 * category has since been reclassified to `kind='fund'` (checked fresh here,
 * not trusted from the snapshot), in which case it falls back to `null`
 * rather than silently populating a fund's transactions. Guard: only if
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
    // Rule 11: read the prior category's CURRENT kind inside this same write
    // transaction, not trusted from the snapshot's moment — the snapshot is
    // whatever the categorize action saw, which can be stale by the time this
    // undo runs (the 10s toast window is exactly long enough for a second tab
    // to reclassify that category to `fund` via the `⋯` menu).
    const priorCategoryIsFund =
      snapshot.targetPriorCategoryId !== null &&
      tx
        .select({ kind: schema.categories.kind })
        .from(schema.categories)
        .where(eq(schema.categories.id, snapshot.targetPriorCategoryId))
        .get()?.kind === "fund";
    const restoreCategoryId = priorCategoryIsFund
      ? null
      : snapshot.targetPriorCategoryId;

    const targetResult = tx
      .update(schema.transactions)
      .set({ categoryId: restoreCategoryId, updatedAt: new Date() })
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

    if (!targetReverted) {
      return { targetReverted: false, revertedApplyToPastCount, ruleAction };
    }
    return {
      targetReverted: true,
      restoredCategoryId: restoreCategoryId,
      priorCategoryBecameFund: priorCategoryIsFund,
      revertedApplyToPastCount,
      ruleAction,
    };
  });
}

