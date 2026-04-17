import { and, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import { parseIsoMonth } from "@/lib/budget/monthOfIso";
import {
  CategoryNotFoundError,
  ParentAllocationError,
  SavingsGoalCategoryError,
} from "@/lib/categoryErrors";
import { createOrUpdateRule } from "@/lib/rules";
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

export type BulkCategorizeSnapshot = {
  normalizedMerchant: string;
  /** The new category assigned to every `txnIds` row. */
  categoryId: number;
  /** IDs of transactions the bulk actually flipped from NULL → categoryId. */
  txnIds: number[];
  /** True when the caller ticked Remember and a rule was upserted. */
  ruleTouched: boolean;
  /** `null` when no exact rule existed before the upsert. */
  priorRule: PriorRuleSnapshot | null;
  /** Earliest `date` seen in `txnIds` (YYYY-MM-DD), or `null` if empty. */
  earliestDate: string | null;
};

export type BulkCategorizeResult = BulkCategorizeSnapshot & {
  /** Number of rows actually flipped (== `txnIds.length`). */
  updatedCount: number;
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
      isSavingsGoal: schema.categories.isSavingsGoal,
    })
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();
  if (!category) throw new CategoryNotFoundError(categoryId);
  if (category.isSavingsGoal) {
    throw new SavingsGoalCategoryError(category.id, category.name);
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
    let ruleTouched = false;

    if (rememberMerchant) {
      const existing = tx
        .select()
        .from(schema.categoryRules)
        .where(
          and(
            eq(schema.categoryRules.matchType, "exact"),
            eq(schema.categoryRules.matchValue, normalizedMerchant),
          ),
        )
        .get();
      if (existing) {
        priorRule = {
          id: existing.id,
          categoryId: existing.categoryId,
          matchType: existing.matchType,
          matchValue: existing.matchValue,
          priority: existing.priority,
          source: existing.source,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
        };
      }
      createOrUpdateRule(tx, {
        normalizedMerchant,
        categoryId,
        source: "manual",
      });
      ruleTouched = true;
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
      earliestDate,
      updatedCount: txnIds.length,
    };
  });
}

