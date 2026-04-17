"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  categorizeTransaction,
  type CategorizeTransactionSnapshot,
} from "@/lib/categorize/categorizeTransaction";
import { undoCategorizeTransaction } from "@/lib/categorize/undoCategorizeTransaction";
import { validateCategorizeTransactionInput } from "@/lib/categorize/validateCategorizeTransactionInput";
import { validateCategorizeTransactionSnapshot } from "@/lib/categorize/validateCategorizeTransactionSnapshot";

/**
 * Flip a single transaction onto a category. Optional "Remember for all
 * [merchant]" upserts an exact rule; optional "Apply to past [merchant]"
 * fans the same category out to every NULL-category, non-transfer row for
 * that merchant.
 *
 * Returns the snapshot required to reverse the action via
 * {@link undoCategorizeTransactionAction}.
 */
export async function categorizeTransactionAction(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const parsed = validateCategorizeTransactionInput(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid categorize transaction input — ${issues}`);
  }

  const result = categorizeTransaction(db, parsed.data);

  const snapshot: CategorizeTransactionSnapshot = {
    normalizedMerchant: result.normalizedMerchant,
    newCategoryId: result.newCategoryId,
    targetTxnId: result.targetTxnId,
    targetPriorCategoryId: result.targetPriorCategoryId,
    targetDate: result.targetDate,
    applyToPastTxnIds: result.applyToPastTxnIds,
    earliestApplyToPastDate: result.earliestApplyToPastDate,
    ruleTouched: result.ruleTouched,
    priorRule: result.priorRule,
  };

  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");

  return {
    snapshot,
    updatedCount: result.updatedCount,
    categoryName: result.categoryName,
  };
}

/**
 * Reverse a prior {@link categorizeTransactionAction}. Idempotent on the
 * target + applyToPast rows — user re-categorizations are preserved.
 */
export async function undoCategorizeTransactionAction(
  snapshot: CategorizeTransactionSnapshot,
) {
  const parsed = validateCategorizeTransactionSnapshot(snapshot);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(snapshot)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid undo snapshot — ${issues}`);
  }

  const result = undoCategorizeTransaction(db, parsed.data);
  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");
  return result;
}
