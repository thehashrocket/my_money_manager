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
    earliestDate: result.earliestDate,
  };

  const categoryRow = db
    .select({ name: schema.categories.name })
    .from(schema.categories)
    .where(eq(schema.categories.id, result.categoryId))
    .get();

  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");

  return {
    snapshot,
    updatedCount: result.updatedCount,
    categoryName: categoryRow?.name ?? `Category ${result.categoryId}`,
  };
}

/**
 * Reverse a prior {@link bulkCategorizeMerchantAction}. Idempotent on
 * transactions — rows the user re-categorized after the snapshot stay put.
 */
export async function undoBulkCategorizeAction(
  snapshot: BulkCategorizeSnapshot,
) {
  const result = undoBulkCategorize(db, snapshot);
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");
  return result;
}
