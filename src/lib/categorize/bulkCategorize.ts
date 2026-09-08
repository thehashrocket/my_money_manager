import { and, eq, inArray, isNull } from "drizzle-orm";
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
import type { CategoryRule } from "@/db/schema";
import type { TrainabilityRefusal } from "./keyTrainability";
import { resolveKeyTrainability } from "./resolveKeyTrainability";
import type { BulkCategorizeInput } from "./validateBulkCategorizeInput";

type Db = typeof defaultDb;

/**
 * Exact snapshot of the rule row that existed BEFORE the bulk upsert. All
 * user-owned columns are captured; `undoBulkCategorize` uses this to either
 * delete the inserted rule (when `priorRule = null`) or restore every column
 * of the prior row verbatim.
 */
export type PriorRuleSnapshot = {
  id: number;
  categoryId: number;
  matchType: "exact" | "contains" | "regex";
  matchValue: string;
  priority: number;
  source: "auto" | "manual";
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Narrow a `category_rules` row to the columns an undo restores. Both write
 * paths and both refusal deletions build the same shape; spelling it out four
 * times is how one of them ends up missing a column.
 */
export function toPriorRuleSnapshot(rule: CategoryRule): PriorRuleSnapshot {
  return {
    id: rule.id,
    categoryId: rule.categoryId,
    matchType: rule.matchType,
    matchValue: rule.matchValue,
    priority: rule.priority,
    source: rule.source,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

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
   * a second bulk ran between the original and the undo.
   * `null` when `priorRule != null` (the undo restores via prior.id instead).
   */
  insertedRuleId: number | null;
  /** Earliest `date` seen in `txnIds` (YYYY-MM-DD), or `null` if empty. */
  earliestDate: string | null;
};

export type BulkCategorizeResult = BulkCategorizeSnapshot & {
  /** Number of rows actually flipped (== `txnIds.length`). */
  updatedCount: number;
  /**
   * Set when Remember was ticked but the key is not safe to train a rule on
   * (see `keyTrainability.ts`). The rows are still filed; only the rule is
   * withheld. Deliberately NOT part of `BulkCategorizeSnapshot`: it is the
   * reason for a decision, not state to reverse, and `ruleTouched` +
   * `priorRule` already carry everything the undo needs — including the case
   * where the refusal DELETED a rule.
   */
  ruleRefusal: TrainabilityRefusal | null;
  /**
   * True when the refusal removed an exact rule that already pointed this key
   * somewhere. The rows are still filed and the deletion is undoable, but the
   * user ticked a box and a rule disappeared, so the surfaces say so rather
   * than reporting the bare "Rule not saved."
   */
  refusalDeletedRule: boolean;
};

/**
 * Flip every uncategorized, non-transfer transaction for `normalizedMerchant`
 * onto `categoryId` in a single DB transaction. Optionally upserts the exact
 * rule for the merchant.
 *
 * Rule upsert (C1): when `rememberMerchant` is true, the existing exact rule
 * (if any) is captured into the snapshot BEFORE the upsert runs. The inline
 * badge on `/categorize` already showed the conflict pre-click; this silently
 * replaces the rule target.
 *
 * Rule REFUSAL: the upsert is skipped entirely when the key is not safe to
 * train (`keyTrainability.ts` — a lossy key like `ONLINE`, or one this ledger
 * has already filed to two different categories), and any exact rule already
 * held for the key is DELETED (`deleteExactRule` carries the reasoning). The
 * refusal withholds the RULE only; the rows are still filed, because the
 * user's decision about these rows is sound even when generalizing it is not.
 * `/categorize` disables the checkbox for such keys, so reaching this branch
 * means a stale form or a direct action call — hence a returned `ruleRefusal`
 * rather than a throw, which would also discard the categorization the user
 * did want.
 *
 * Invalidation: the earliest month in `txnIds` is the floor for
 * `invalidateForwardRollover`. Spend changed on `categoryId` starting that
 * month, so every downstream rollover row for that category must recompute.
 * (The old category for these rows was NULL → no prior attribution to clear.)
 *
 * Defensive DB-bound rejects (pure Zod validator already covered shape):
 * - category not found → `CategoryNotFoundError`
 * - parent category → `ParentAllocationError` (dropdown filters leaves, but a
 *   tampered form could still submit one)
 * - savings goal → `SavingsGoalCategoryError`
 */
export function bulkCategorize(
  db: Db,
  input: BulkCategorizeInput,
): BulkCategorizeResult {
  const { normalizedMerchant, categoryId, rememberMerchant } = input;

  const category = db
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

  const firstChild = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.parentId, categoryId))
    .limit(1)
    .get();
  if (firstChild) throw new ParentAllocationError(category.id, category.name);

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

    let priorRule: PriorRuleSnapshot | null = null;
    let insertedRuleId: number | null = null;
    let ruleTouched = false;
    let refusalDeletedRule = false;

    /* Resolved BEFORE the row UPDATE below, so both write paths judge the key
       at the same point in their own transaction. The ordering does not change
       the verdict HERE — `matchingRows` is filtered to `categoryId IS NULL`,
       so none of these rows is in the filed set beforehand and all of them
       land on the one category the union already carries. It is load-bearing
       in `categorizeTransaction`, which can move an ALREADY-filed row: read
       after its UPDATE, the category being left has vanished from the ledger
       and the split the user is creating is invisible. */
    const verdict = rememberMerchant
      ? resolveKeyTrainability(tx, normalizedMerchant, categoryId)
      : null;
    const ruleRefusal =
      verdict !== null && !verdict.trainable ? verdict : null;

    if (rememberMerchant && ruleRefusal === null) {
      const existing = readExactRule(tx, normalizedMerchant);
      if (existing) {
        priorRule = toPriorRuleSnapshot(existing);
      }
      const upserted = createOrUpdateRule(tx, {
        normalizedMerchant,
        categoryId,
        source: "manual",
      });
      ruleTouched = true;
      if (priorRule === null) {
        insertedRuleId = upserted.id;
      }
    } else if (ruleRefusal !== null) {
      /* A refusal does not just decline to WRITE a rule — it removes the one
         already there. See `deleteExactRule`: leaving it standing left a rule
         the user had just contradicted auto-filing every future import, with
         no surface anywhere in the app able to edit or delete it. Reported by
         the /ship review; decision d0995fa9.

         Snapshotted into `priorRule` with `ruleTouched = true`, so Undo puts
         it back through the same branch that restores an overwritten rule —
         which is why that branch has to re-INSERT a row that is gone rather
         than only UPDATE one in place. */
      const removed = deleteExactRule(tx, normalizedMerchant);
      if (removed) {
        priorRule = toPriorRuleSnapshot(removed);
        ruleTouched = true;
        refusalDeletedRule = true;
      }
    }

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
      ruleTouched,
      priorRule,
      insertedRuleId,
      earliestDate,
      updatedCount: txnIds.length,
      ruleRefusal,
      refusalDeletedRule,
    };
  });
}

