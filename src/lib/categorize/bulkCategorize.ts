import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import { parseIsoMonth } from "@/lib/budget/monthOfIso";
import { applyRuleWrite, type RuleRefusalReport } from "./applyRuleWrite";
import { assertAssignableCategory } from "./assertAssignableCategory";
import type { PriorRuleSnapshot } from "./priorRuleSnapshot";
import type { BulkCategorizeInput } from "./validateBulkCategorizeInput";

type Db = typeof defaultDb;

export type BulkCategorizeSnapshot = {
  normalizedMerchant: string;
  /** The new category assigned to every `txnIds` row. */
  categoryId: number;
  /** IDs of transactions the bulk actually flipped from NULL → categoryId. */
  txnIds: number[];
  /**
   * True when this call changed the rules table — either the caller ticked
   * Remember and a rule was upserted, or the trainability guard refused and
   * deleted the rule that was already there. Both cases give the undo
   * something to reverse, which is the only thing this flag is read for.
   */
  ruleTouched: boolean;
  /**
   * The rule row as it stood before this call: `null` when no exact rule
   * existed, otherwise the row that was overwritten (upsert) or removed
   * (refusal). The undo path cannot tell those two apart and does not need
   * to — it restores this row either way.
   */
  priorRule: PriorRuleSnapshot | null;
  /**
   * ID of the newly inserted rule row when `priorRule = null` (no prior rule
   * existed). `undoBulkCategorize` uses this to delete by primary key rather
   * than by (match_type, match_value, category_id), which would be unsafe if
   * a second write retargeted that row between the original and the undo.
   * `null` when `priorRule != null` (the undo restores via prior.id instead).
   */
  insertedRuleId: number | null;
  /** Earliest `date` seen in `txnIds` (YYYY-MM-DD), or `null` if empty. */
  earliestDate: string | null;
};

export type BulkCategorizeOptions = {
  /**
   * Let a refusal REMOVE the exact rule the user has just contradicted. Off by
   * default and never sourced from a form — see `applyRuleWrite`, which owns the
   * reasoning. `/categorize` opts in; `/subscriptions`' sweep does not.
   */
  allowRuleRemoval?: boolean;
};

export type BulkCategorizeResult = BulkCategorizeSnapshot & {
  /** Number of rows actually flipped (== `txnIds.length`). */
  updatedCount: number;
  /**
   * Set when Remember was ticked but the key is not safe to train a rule on
   * (see `keyTrainability.ts`), carrying the rule the refusal removed when it
   * removed one. The rows are still filed; only the rule is withheld.
   *
   * Deliberately NOT part of `BulkCategorizeSnapshot`: it is the reason for a
   * decision, not state to reverse, and `ruleTouched` + `priorRule` already
   * carry everything the undo needs — including the case where the refusal
   * DELETED a rule.
   */
  ruleRefusal: RuleRefusalReport | null;
};

/**
 * Flip every uncategorized, non-transfer transaction for `normalizedMerchant`
 * onto `categoryId` in a single DB transaction. Optionally upserts the exact
 * rule for the merchant.
 *
 * Rule handling — including the refusal, and when a refusal deletes the rule
 * that was already there — lives entirely in `applyRuleWrite`, shared with
 * `categorizeTransaction`. No `excludeTxnIds` is passed: this only ever touches
 * `categoryId IS NULL` rows, which the filed-categories query skips anyway.
 *
 * A refusal withholds the RULE only; the rows are still filed, because the
 * user's decision about these rows is sound even when generalizing it is not.
 * `/categorize` disables the checkbox for such keys, but this path is also
 * reached without any UI in front of it — `/subscriptions` passes
 * `rememberMerchant: true` unconditionally — hence a returned `ruleRefusal`
 * rather than a throw, which would also discard the categorization the user
 * did want.
 *
 * Invalidation: the earliest month in `txnIds` is the floor for
 * `invalidateForwardRollover`. Spend changed on `categoryId` starting that
 * month, so every downstream rollover row for that category must recompute.
 * (The old category for these rows was NULL → no prior attribution to clear.)
 *
 * Defensive DB-bound rejects (the pure Zod validator already covered shape)
 * live in `assertAssignableCategory`, shared with `categorizeTransaction` and
 * `bulkRetarget`: not found, savings goal, archived, parent.
 */
export function bulkCategorize(
  db: Db,
  input: BulkCategorizeInput,
  options: BulkCategorizeOptions = {},
): BulkCategorizeResult {
  const { normalizedMerchant, categoryId, rememberMerchant } = input;

  assertAssignableCategory(db, categoryId);

  return db.transaction((tx) => {
    const matchingRows = tx
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
        ),
      )
      .all();

    const txnIds = matchingRows.map((r) => r.id);
    const earliestDate = matchingRows.reduce<string | null>((acc, r) => {
      if (!acc || r.date < acc) return r.date;
      return acc;
    }, null);

    const rule = applyRuleWrite(tx, {
      normalizedMerchant,
      categoryId,
      rememberMerchant,
      allowRuleRemoval: options.allowRuleRemoval,
    });

    if (txnIds.length > 0) {
      tx.update(schema.transactions)
        .set({ categoryId, updatedAt: new Date() })
        .where(inArray(schema.transactions.id, txnIds))
        .run();

      if (earliestDate) {
        const { year, month } = parseIsoMonth(earliestDate);
        invalidateForwardRollover(tx, categoryId, year, month);
      }
    }

    return {
      normalizedMerchant,
      categoryId,
      txnIds,
      ruleTouched: rule.ruleTouched,
      priorRule: rule.priorRule,
      insertedRuleId: rule.insertedRuleId,
      earliestDate,
      updatedCount: txnIds.length,
      ruleRefusal: rule.ruleRefusal,
    };
  });
}
