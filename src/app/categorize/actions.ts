"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import {
  bulkCategorize,
  type BulkCategorizeSnapshot,
} from "@/lib/categorize/bulkCategorize";
import { undoBulkCategorize } from "@/lib/categorize/undoBulkCategorize";
import { validateBulkCategorizeInput } from "@/lib/categorize/validateBulkCategorizeInput";
import { validateBulkCategorizeSnapshot } from "@/lib/categorize/validateBulkCategorizeSnapshot";

/**
 * Flip every uncategorized row for a merchant onto a category, optionally
 * upserting the exact rule. Returns the snapshot required for a later Undo
 * call so the client island can stash it for the 10s window.
 *
 * Validation + DB-bound rejects (parent, savings goal, unknown category)
 * throw `Error`; Next.js renders them via `/categorize/error.tsx`.
 */
export async function bulkCategorizeMerchantAction(formData: FormData) {
  const raw = Object.fromEntries(formData);
  const parsed = validateBulkCategorizeInput(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid bulk categorize input — ${issues}`);
  }

  const result = bulkCategorize(db, parsed.data);

  const snapshot: BulkCategorizeSnapshot = {
    normalizedMerchant: result.normalizedMerchant,
    categoryId: result.categoryId,
    txnIds: result.txnIds,
    ruleTouched: result.ruleTouched,
    priorRule: result.priorRule,
    insertedRuleId: result.insertedRuleId,
    earliestDate: result.earliestDate,
  };

  const categoryRow = db
    .select({ name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.id, result.categoryId))
    .get();

  // `/transactions` too, and not only for symmetry with its own actions
  // (which already revalidate `/categorize`): the drilldown makes these two
  // pages a round trip. `/transactions?merchant=X` → "Categorize all N →" →
  // file them here → back. Without this, the page you return to still lists
  // those rows as Uncategorized, under a header breakdown that no longer
  // matches the ledger.
  revalidatePath("/categorize");
  revalidatePath("/transactions");
  revalidatePath("/budget", "layout");

  return {
    snapshot,
    updatedCount: result.updatedCount,
    categoryName: categoryRow?.name ?? `Category ${result.categoryId}`,
    // `/categorize` disables the checkbox for an untrainable key, so this is
    // normally null. It is still returned because "disabled in the UI" is not
    // an enforcement boundary — a stale tab holding a form from before the
    // key's filing history changed can still post `rememberMerchant=true`.
    ruleRefusal: result.ruleRefusal,
    refusalDeletedRule: result.refusalDeletedRule,
  };
}

/**
 * Reverse a prior {@link bulkCategorizeMerchantAction}. Idempotent on
 * transactions — rows the user re-categorized after the snapshot stay put.
 */
export async function undoBulkCategorizeAction(
  snapshot: BulkCategorizeSnapshot,
) {
  const parsed = validateBulkCategorizeSnapshot(snapshot);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid undo snapshot — ${issues}`);
  }

  const result = undoBulkCategorize(db, parsed.data);
  revalidatePath("/categorize");
  revalidatePath("/transactions");
  revalidatePath("/budget", "layout");
  return result;
}
