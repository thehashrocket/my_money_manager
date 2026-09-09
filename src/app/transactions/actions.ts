"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  categorizeTransaction,
  type CategorizeTransactionSnapshot,
} from "@/lib/categorize/categorizeTransaction";
import { describeRuleRefusal } from "@/lib/categorize/refusalNotice";
import {
  runBulkRetarget,
  runUndoBulkRetarget,
  type BulkRetargetRunResult,
  type UndoBulkRetargetRunResult,
} from "@/lib/categorize/runBulkRetarget";
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

export type {
  BulkRetargetRunResult as BulkRetargetActionResult,
  UndoBulkRetargetRunResult as UndoBulkRetargetActionResult,
} from "@/lib/categorize/runBulkRetarget";

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
 * The pipeline itself is `runBulkRetarget`, which takes an explicit `db` so a
 * test can drive it; only `revalidatePath` lives here, because it closes over
 * the singleton DB and cannot run under `:memory:`. Outcomes are returned as
 * STATE, never thrown — see that module for why.
 */
export async function bulkRetargetAction(
  formData: FormData,
): Promise<BulkRetargetRunResult> {
  const result = runBulkRetarget(db, Object.fromEntries(formData));
  if (result.status === "error") return result;

  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");
  revalidatePath("/goals");
  revalidatePath("/");
  return result;
}

/**
 * Reverse a prior {@link bulkRetargetAction}. Rows the user re-categorized
 * inside the undo window are preserved.
 */
export async function undoBulkRetargetAction(
  snapshot: unknown,
): Promise<UndoBulkRetargetRunResult> {
  const result = runUndoBulkRetarget(db, snapshot);
  if (result.status === "error") return result;

  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");
  revalidatePath("/goals");
  revalidatePath("/");
  return result;
}
