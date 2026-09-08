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
import { applyRuleWrite, type RuleRefusalReport } from "./applyRuleWrite";
import {
  TransactionNotFoundError,
  TransferPairedTransactionError,
} from "./categorizeTransactionErrors";
import type { PriorRuleSnapshot } from "./priorRuleSnapshot";
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
  /**
   * ID of the newly inserted rule row when `priorRule = null`.
   *
   * This snapshot went without it while `bulkCategorize`'s twin had it, so this
   * undo path deleted its inserted rule by (match_type, match_value,
   * category_id) — the very lookup the sibling's doc comment calls unsafe when
   * a second write can retarget the row mid-window. `/subscriptions` is such a
   * write, so the two paths now carry the same field and delete by primary key.
   */
  insertedRuleId: number | null;
};

export type CategorizeTransactionOptions = {
  /**
   * Let a refusal REMOVE the exact rule the user has just contradicted. Off by
   * default and never sourced from a form — see `applyRuleWrite`.
   */
  allowRuleRemoval?: boolean;
};

export type CategorizeTransactionResult = CategorizeTransactionSnapshot & {
  /** Total rows flipped: 1 (target) + applyToPast hits. */
  updatedCount: number;
  /** Name of the newly assigned category — for the Sonner toast. */
  categoryName: string;
  /**
   * Set when Remember was ticked but the key is not safe to train a rule on
   * (see `keyTrainability.ts`), carrying the rule the refusal removed when it
   * removed one. Rows are still filed; only the rule is withheld. Not part of
   * the snapshot: it is the reason for a decision, not state to reverse, and
   * `ruleTouched` + `priorRule` already carry what the undo needs.
   */
  ruleRefusal: RuleRefusalReport | null;
};

/**
 * Single-row categorize for `/transactions`. Flips the target txn onto
 * `categoryId`; optionally applies to every NULL-category row for the same
 * `normalized_merchant`; optionally upserts the exact rule.
 *
 * Server-trust: `normalizedMerchant` is NOT read from the form. We resolve it
 * server-side from the target row so a tampered applyToPast can't broadcast
 * across merchants. The Remember guard is enforced here for the same reason —
 * `/transactions` renders this checkbox on every row without knowing the key's
 * filing history, so the server is the only place that can answer it.
 *
 * Rule handling lives in `applyRuleWrite`, shared with `bulkCategorize`, and the
 * target row's id is passed as `excludeTxnIds`: this is the path that can
 * RETARGET an already-filed row, so the verdict has to be about the ledger the
 * action leaves behind rather than the one it found. Moving a key's only filed
 * row to a new category used to be refused on the category it was leaving.
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
  options: CategorizeTransactionOptions = {},
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

    /* Hoisted above the UPDATEs for readability only. Excluding the target row
       is what makes the verdict the same on either side of them; the
       applyToPast rows need no excluding because they are `categoryId IS NULL`
       and the filed-categories query already skips those. */
    const rule = applyRuleWrite(tx, {
      normalizedMerchant,
      categoryId,
      rememberMerchant,
      excludeTxnIds: [target.id],
      allowRuleRemoval: options.allowRuleRemoval,
    });

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
      ruleTouched: rule.ruleTouched,
      priorRule: rule.priorRule,
      insertedRuleId: rule.insertedRuleId,
      updatedCount: 1 + applyToPastTxnIds.length,
      categoryName: category.name,
      ruleRefusal: rule.ruleRefusal,
    };
  });
}

function earlierDate(a: string, b: string | null): string {
  if (b === null) return a;
  return a < b ? a : b;
}
