"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import {
  bulkCategorize,
  type BulkCategorizeSnapshot,
} from "@/lib/categorize/bulkCategorize";
import { describeRuleRefusal } from "@/lib/categorize/refusalNotice";
import { undoBulkCategorize } from "@/lib/categorize/undoBulkCategorize";
import { validateBulkCategorizeInput } from "@/lib/categorize/validateBulkCategorizeInput";
import { validateBulkCategorizeSnapshot } from "@/lib/categorize/validateBulkCategorizeSnapshot";
import { guardRefresh } from "@/lib/revalidateAfterWrite";

/**
 * The ONE post-commit refresh for this route, guarded.
 *
 * Both actions here revalidate the same three paths, and both do it AFTER a
 * write that has already committed — one of which may have DELETED a trained
 * `category_rules` row (rule 6). The snapshot that undoes that deletion is
 * returned BELOW this call, so an unguarded `revalidatePath` throw did not
 * merely leave a stale page: it discarded the snapshot on its way out, the
 * client's `catch` rendered "Categorize failed." for a write that landed, and
 * the 10s Undo — the only way back for a removed rule — never appeared.
 *
 * Returns the warning rather than `void`, and a caller that drops it makes a
 * failed refresh silent again. See `@/lib/revalidateAfterWrite`.
 *
 * `/transactions` is revalidated too, and not only for symmetry with its own
 * actions (which already revalidate `/categorize`): the drilldown makes these
 * two pages a round trip. `/transactions?merchant=X` → "Categorize all N →" →
 * file them here → back. Without it, the page you return to still lists those
 * rows as Uncategorized, under a header breakdown that no longer matches the
 * ledger.
 */
function revalidateAfterWrite(): string | undefined {
  return guardRefresh("/categorize", () => {
    revalidatePath("/categorize");
    revalidatePath("/transactions");
    revalidatePath("/budget", "layout");
  });
}

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

  /* `allowRuleRemoval` is passed HERE and not defaulted inside the library: the
     Remember checkbox on this page is a deliberate, per-merchant retrain, which
     is the only gesture that licenses removing a rule the user has contradicted.
     It is an argument rather than a form field so no stale or crafted post can
     turn a sweep into a rule deletion — see `applyRuleWrite`. */
  const result = bulkCategorize(db, parsed.data, { allowRuleRemoval: true });

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

  const warning = revalidateAfterWrite();

  return {
    snapshot,
    // A failed refresh NEVER turns this committed write into a failure — it
    // rides out beside the snapshot so the row can merge it into the one
    // toast that also carries the Undo.
    warning,
    updatedCount: result.updatedCount,
    categoryName: categoryRow?.name ?? `Category ${result.categoryId}`,
    // `/categorize` disables the checkbox for an untrainable key, so this is
    // normally null. It is still returned because "disabled in the UI" is not
    // an enforcement boundary: a stale tab can post `rememberMerchant=true`,
    // and `/subscriptions` calls the same function with no UI in front of it.
    //
    // Resolved to a finished sentence here rather than handed over raw — the
    // fact worth telling the user is the NAME of the category a removed rule
    // pointed at, and only the server can look that up.
    ruleRefusal:
      result.ruleRefusal === null
        ? null
        : describeRuleRefusal(db, result.ruleRefusal),
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
  // The undo is itself a committed write — it puts a removed rule back
  // (`restorePriorRule`) — so its refresh gets the same treatment.
  return { ...result, warning: revalidateAfterWrite() };
}
