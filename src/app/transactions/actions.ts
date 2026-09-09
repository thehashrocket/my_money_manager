"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  bulkRetarget,
  type BulkRetargetSnapshot,
} from "@/lib/categorize/bulkRetarget";
import {
  categorizeTransaction,
  type CategorizeTransactionSnapshot,
} from "@/lib/categorize/categorizeTransaction";
import { describeRuleRefusal } from "@/lib/categorize/refusalNotice";
import { undoBulkRetarget } from "@/lib/categorize/undoBulkRetarget";
import { undoCategorizeTransaction } from "@/lib/categorize/undoCategorizeTransaction";
import { validateBulkRetargetInput } from "@/lib/categorize/validateBulkRetargetInput";
import { validateBulkRetargetSnapshot } from "@/lib/categorize/validateBulkRetargetSnapshot";
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

  /* `/goals` and `/` join the older three because every action in this
     file moves rows BETWEEN categories. A fund's rows are `loadGoals`'
     withdrawn term, and any expense→expense move redraws the dashboard's
     6-month trend chart — `bulkRetarget` most of all, since it is the one
     bulk path here and applies no check to the SOURCE category at all
     ("a fund holding rows is a state this action should help drain").
     Leaving either stale is the same freshness bug the editable FUNDS
     band hit from the other side. */
  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");
  revalidatePath("/goals");
  revalidatePath("/");

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
  revalidatePath("/goals");
  revalidatePath("/");
  return result;
}

/**
 * Move every non-transfer row for one merchant off the category it is filed
 * under and onto another — the repair for a bulk categorize that went to the
 * wrong place. Optional "Remember" retrains the merchant's exact rule to
 * follow the rows.
 *
 * Reachable only from the merchant drilldown (`/transactions?merchant=…`),
 * which is the surface that still lists a group after `/categorize` has
 * stopped showing it: `loadMerchantGroups` filters on `category_id IS NULL`,
 * so a fully-filed group disappears from the page you filed it on. That is
 * why the repair could not live there.
 *
 * Returns the snapshot required to reverse it via
 * {@link undoBulkRetargetAction}.
 */
export async function bulkRetargetAction(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const parsed = validateBulkRetargetInput(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid retarget input — ${issues}`);
  }

  /* Same opt-in as the row form above, for the same reason: naming a merchant
     and moving its history is the most deliberate per-merchant retrain the app
     offers, so a refusal here may remove the rule the user has just
     contradicted. An argument, never a form field (`applyRuleWrite`). */
  const result = bulkRetarget(db, parsed.data, { allowRuleRemoval: true });

  const snapshot: BulkRetargetSnapshot = {
    normalizedMerchant: result.normalizedMerchant,
    fromCategoryId: result.fromCategoryId,
    categoryId: result.categoryId,
    txnIds: result.txnIds,
    ruleTouched: result.ruleTouched,
    priorRule: result.priorRule,
    insertedRuleId: result.insertedRuleId,
    earliestDate: result.earliestDate,
  };

  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");
  revalidatePath("/goals");
  revalidatePath("/");

  return {
    snapshot,
    updatedCount: result.updatedCount,
    categoryName: result.categoryName,
    fromCategoryName: result.fromCategoryName,
    // Outside `snapshot` for the reason its sibling documents: a refusal is a
    // REASON, not state to reverse, and it is resolved to a finished sentence
    // server-side because naming a removed rule's category needs a lookup.
    ruleRefusal:
      result.ruleRefusal === null
        ? null
        : describeRuleRefusal(db, result.ruleRefusal),
  };
}

/**
 * Reverse a prior {@link bulkRetargetAction}. Rows the user re-categorized
 * inside the undo window are preserved.
 */
export async function undoBulkRetargetAction(snapshot: BulkRetargetSnapshot) {
  const parsed = validateBulkRetargetSnapshot(snapshot);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(snapshot)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid undo snapshot — ${issues}`);
  }

  const result = undoBulkRetarget(db, parsed.data);
  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");
  revalidatePath("/goals");
  revalidatePath("/");
  return result;
}
