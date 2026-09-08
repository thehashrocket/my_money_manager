"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  categorizeTransaction,
  type CategorizeTransactionSnapshot,
} from "@/lib/categorize/categorizeTransaction";
import { describeRuleRefusal } from "@/lib/categorize/refusalNotice";
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

  /* See the note in `/categorize`'s action: ticking Remember on a row is a
     deliberate per-merchant retrain, so this surface opts in to a refusal
     removing the rule it contradicts. Never a form field. */
  const result = categorizeTransaction(db, parsed.data, {
    allowRuleRemoval: true,
  });

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
    insertedRuleId: result.insertedRuleId,
  };

  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");

  return {
    snapshot,
    updatedCount: result.updatedCount,
    categoryName: result.categoryName,
    // Deliberately outside `snapshot`: the refusal is a REASON, not state to
    // reverse. When it also removed a rule, `snapshot.priorRule` +
    // `ruleTouched` already carry that for the undo. This rides the result only
    // so the row can say why the box it ticked did nothing, and what happened
    // to the rule that was there — resolved to a finished sentence server-side,
    // because naming the removed rule's category needs a lookup.
    ruleRefusal:
      result.ruleRefusal === null
        ? null
        : describeRuleRefusal(db, result.ruleRefusal),
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
