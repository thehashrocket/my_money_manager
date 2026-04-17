import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db as defaultDb, schema } from "@/db";
import { invalidateForwardRollover } from "@/lib/budget";
import { parseIsoMonth } from "@/lib/budget/monthOfIso";
import {
  CategoryNotFoundError,
  ParentAllocationError,
  SavingsGoalCategoryError,
} from "@/lib/categoryErrors";
import { createOrUpdateRule } from "@/lib/rules";
import type { PriorRuleSnapshot } from "./bulkCategorize";
import {
  TransactionNotFoundError,
  TransferPairedTransactionError,
} from "./categorizeTransactionErrors";
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
  /** True when the caller ticked Remember and a rule was upserted. */
  ruleTouched: boolean;
  /** Rule row that existed BEFORE the upsert, or `null` if none. */
  priorRule: PriorRuleSnapshot | null;
};

export type CategorizeTransactionResult = CategorizeTransactionSnapshot & {
  /** Total rows flipped: 1 (target) + applyToPast hits. */
  updatedCount: number;
  /** Name of the newly assigned category — for the Sonner toast. */
  categoryName: string;
};

/**
 * Single-row categorize for `/transactions`. Flips the target txn onto
 * `categoryId`; optionally applies to every NULL-category row for the same
 * `normalized_merchant`; optionally upserts the exact rule.
 *
 * Server-trust: `normalizedMerchant` is NOT read from the form. We resolve it
 * server-side from the target row so a tampered applyToPast can't broadcast
 * across merchants.
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
    };
  });
}

function earlierDate(a: string, b: string | null): string {
  if (b === null) return a;
  return a < b ? a : b;
}
