import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import { parseIsoMonth } from "@/lib/budget/monthOfIso";
import {
  CategoryArchivedError,
  CategoryNotFoundError,
  ParentAllocationError,
  SavingsGoalCategoryError,
} from "@/lib/categoryErrors";
import { createOrUpdateRule, deleteExactRule, readExactRule } from "@/lib/rules";
import { toPriorRuleSnapshot, type PriorRuleSnapshot } from "./bulkCategorize";
import {
  TransactionNotFoundError,
  TransferPairedTransactionError,
} from "./categorizeTransactionErrors";
import type { TrainabilityRefusal } from "./keyTrainability";
import { resolveKeyTrainability } from "./resolveKeyTrainability";
import type { CategorizeTransactionInput } from "./validateCategorizeTransactionInput";

type Db = typeof defaultDb;

export type CategorizeTransactionSnapshot = {
  normalizedMerchant: string;
  newCategoryId: number;
  targetTxnId: number;
  /** Prior category on the target row — `null` if it was uncategorized. */
  targetPriorCategoryId: number | null;
  /** ISO date of the target row. Used to locate the prior-category invalidation month on undo. */
  targetDate: string;
  /** IDs flipped by the "Apply to past" pass; all had `categoryId = NULL`. */
  applyToPastTxnIds: number[];
  /** Earliest date seen in `applyToPastTxnIds`, or `null` if none. */
  earliestApplyToPastDate: string | null;
  /**
   * True when this call changed the rules table — either Remember was ticked
   * and a rule was upserted, or the trainability guard refused and deleted the
   * rule that was already there. Both leave the undo something to reverse.
   */
  ruleTouched: boolean;
  /**
   * The rule row as it stood before this call: `null` when none existed,
   * otherwise the row that was overwritten (upsert) or removed (refusal).
   * The undo restores it either way and cannot tell the two apart.
   */
  priorRule: PriorRuleSnapshot | null;
};

export type CategorizeTransactionResult = CategorizeTransactionSnapshot & {
  /** Total rows flipped: 1 (target) + applyToPast hits. */
  updatedCount: number;
  /** Name of the newly assigned category — for the Sonner toast. */
  categoryName: string;
  /**
   * Set when Remember was ticked but the key is not safe to train a rule on
   * (see `keyTrainability.ts`). Rows are still filed; only the rule is
   * withheld. Not part of the snapshot: it is the reason for a decision, not
   * state to reverse, and `ruleTouched` + `priorRule` already carry what the
   * undo needs — including the case where the refusal DELETED a rule.
   */
  ruleRefusal: TrainabilityRefusal | null;
  /**
   * True when the refusal removed an exact rule that already pointed this key
   * somewhere. Undoable, but the user ticked a box and a rule disappeared, so
   * the row says so rather than reporting the bare "Rule not saved."
   */
  refusalDeletedRule: boolean;
};

/**
 * Single-row categorize for `/transactions`. Flips the target txn onto
 * `categoryId`; optionally applies to every NULL-category row for the same
 * `normalized_merchant`; optionally upserts the exact rule.
 *
 * Server-trust: `normalizedMerchant` is NOT read from the form. We resolve it
 * server-side from the target row so a tampered applyToPast can't broadcast
 * across merchants. The Remember guard below is enforced here for the same
 * reason — `/transactions` renders this checkbox on every row without knowing
 * the key's filing history, so the server is the only place that can answer it.
 *
 * Rule REFUSAL: the upsert is skipped when the key is not safe to train
 * (`keyTrainability.ts`), and any exact rule already held for the key is
 * DELETED — see `deleteExactRule`, and note that this row is the only surface
 * that could ever have retargeted such a rule, so leaving it standing made it
 * permanent. Rows are still filed and `ruleRefusal` carries the reason back
 * for the toast — refusing the whole action would throw away a categorization
 * the user was right about.
 *
 * Invalidation: the new category is invalidated starting at the earliest of
 * (target.date, earliest applyToPast date). If the target had a prior
 * category, that category is also invalidated at the target's date month —
 * spend moved off it too. (The applyToPast rows were NULL before → no prior
 * attribution on that path.)
 */
export function categorizeTransaction(
  db: Db,
  input: CategorizeTransactionInput,
): CategorizeTransactionResult {
  const { transactionId, categoryId, rememberMerchant, applyToPast } = input;

  return db.transaction((tx) => {
    const category = tx
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        kind: schema.categories.kind,
        archivedAt: schema.categories.archivedAt,
      })
      .from(schema.categories)
      .where(eq(schema.categories.id, categoryId))
      .get();
    if (!category) throw new CategoryNotFoundError(categoryId);
    // A2: kind is authoritative, not is_savings_goal (T5).
    if (category.kind === "fund") {
      throw new SavingsGoalCategoryError(category.id, category.name);
    }
    if (category.archivedAt !== null) {
      throw new CategoryArchivedError(category.id, category.name);
    }

    const firstChild = tx
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(eq(schema.categories.parentId, categoryId))
      .limit(1)
      .get();
    if (firstChild) throw new ParentAllocationError(category.id, category.name);

    const target = tx
      .select({
        id: schema.transactions.id,
        date: schema.transactions.date,
        normalizedMerchant: schema.transactions.normalizedMerchant,
        categoryId: schema.transactions.categoryId,
        transferPairId: schema.transactions.transferPairId,
      })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, transactionId))
      .get();
    if (!target) throw new TransactionNotFoundError(transactionId);
    if (target.transferPairId !== null) {
      throw new TransferPairedTransactionError(transactionId);
    }

    const targetPriorCategoryId = target.categoryId;
    const normalizedMerchant = target.normalizedMerchant;

    // Resolved BEFORE the two UPDATEs below. This function files its target
    // row first and upserts the rule last, so checking at the rule site would
    // read a ledger that already contains this action's own writes and count
    // them as prior evidence.
    const verdict = rememberMerchant
      ? resolveKeyTrainability(tx, normalizedMerchant, categoryId)
      : null;
    const ruleRefusal =
      verdict !== null && !verdict.trainable ? verdict : null;

    tx.update(schema.transactions)
      .set({ categoryId, updatedAt: new Date() })
      .where(eq(schema.transactions.id, target.id))
      .run();

    let applyToPastTxnIds: number[] = [];
    let earliestApplyToPastDate: string | null = null;

    if (applyToPast) {
      const candidates = tx
        .select({
          id: schema.transactions.id,
          date: schema.transactions.date,
        })
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.normalizedMerchant, normalizedMerchant),
            isNull(schema.transactions.categoryId),
            isNull(schema.transactions.transferPairId),
            ne(schema.transactions.id, target.id),
          ),
        )
        .all();

      applyToPastTxnIds = candidates.map((r) => r.id);
      earliestApplyToPastDate = candidates.reduce<string | null>((acc, r) => {
        if (!acc || r.date < acc) return r.date;
        return acc;
      }, null);

      if (applyToPastTxnIds.length > 0) {
        tx.update(schema.transactions)
          .set({ categoryId, updatedAt: new Date() })
          .where(inArray(schema.transactions.id, applyToPastTxnIds))
          .run();
      }
    }

    let priorRule: PriorRuleSnapshot | null = null;
    let ruleTouched = false;
    let refusalDeletedRule = false;

    if (rememberMerchant && ruleRefusal === null) {
      const existing = readExactRule(tx, normalizedMerchant);
      if (existing) {
        priorRule = toPriorRuleSnapshot(existing);
      }
      createOrUpdateRule(tx, {
        normalizedMerchant,
        categoryId,
        source: "manual",
      });
      ruleTouched = true;
    } else if (ruleRefusal !== null) {
      /* The refusal removes the rule already held for this key, it does not
         merely decline to write a new one. `deleteExactRule` carries the full
         reasoning; the short version is that this row is the ONLY surface that
         could ever have retargeted such a rule, and the refusal is what shuts
         that door — leaving the rule standing made it permanent. Reported by
         the /ship review; decision d0995fa9. */
      const removed = deleteExactRule(tx, normalizedMerchant);
      if (removed) {
        priorRule = toPriorRuleSnapshot(removed);
        ruleTouched = true;
        refusalDeletedRule = true;
      }
    }

    const newCatEarliest = earlierDate(target.date, earliestApplyToPastDate);
    const { year: newYear, month: newMonth } = parseIsoMonth(newCatEarliest);
    invalidateForwardRollover(tx, categoryId, newYear, newMonth);

    if (targetPriorCategoryId !== null) {
      const { year: priorYear, month: priorMonth } = parseIsoMonth(target.date);
      invalidateForwardRollover(
        tx,
        targetPriorCategoryId,
        priorYear,
        priorMonth,
      );
    }

    return {
      normalizedMerchant,
      newCategoryId: categoryId,
      targetTxnId: target.id,
      targetPriorCategoryId,
      targetDate: target.date,
      applyToPastTxnIds,
      earliestApplyToPastDate,
      ruleTouched,
      priorRule,
      updatedCount: 1 + applyToPastTxnIds.length,
      categoryName: category.name,
      ruleRefusal,
      refusalDeletedRule,
    };
  });
}

function earlierDate(a: string, b: string | null): string {
  if (b === null) return a;
  return a < b ? a : b;
}
