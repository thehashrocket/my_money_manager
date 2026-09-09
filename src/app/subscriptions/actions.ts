"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, schema } from "@/db";
import { guardRefresh } from "@/lib/revalidateAfterWrite";
import {
  fileAllSubscriptions,
  fileSubscription,
} from "@/lib/subscriptions/categorizeSubscriptions";
import type {
  CategorizeAllSubscriptionsResult,
  SubscriptionCategorizeResult,
  SubscriptionDismissResult,
} from "./action-state";

const merchantSchema = z.object({
  normalizedMerchant: z.string().min(1).max(500),
});

/**
 * Route tag for `guardRefresh`'s log line; not user-facing.
 *
 * Declared above its first use rather than at the foot of the file: every
 * reference today sits in a deferred function body, so the old placement
 * worked — but only for that reason, and the next module-level use above the
 * declaration would be a TDZ `ReferenceError` at import time that `tsc` does
 * not flag.
 */
const SCOPE = "/subscriptions";

export async function dismissSubscriptionAction(
  formData: FormData,
): Promise<SubscriptionDismissResult> {
  const parsed = merchantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) throw new Error("Invalid input");

  db.insert(schema.subscriptionDismissals)
    .values({ normalizedMerchant: parsed.data.normalizedMerchant })
    .onConflictDoNothing()
    .run();

  return { warning: guardRefresh(SCOPE, () => revalidatePath("/subscriptions")) };
}

export async function restoreSubscriptionAction(
  formData: FormData,
): Promise<SubscriptionDismissResult> {
  const parsed = merchantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) throw new Error("Invalid input");

  db.delete(schema.subscriptionDismissals)
    .where(
      eq(
        schema.subscriptionDismissals.normalizedMerchant,
        parsed.data.normalizedMerchant,
      ),
    )
    .run();

  return { warning: guardRefresh(SCOPE, () => revalidatePath("/subscriptions")) };
}

/**
 * File one detected subscription onto `Subscriptions`.
 *
 * Thin wrapper: the logic and the outcome shape live in
 * `lib/subscriptions/categorizeSubscriptions.ts`, which takes an explicit `db`
 * so it is testable. This layer validates the untrusted form input and
 * revalidates the pages the write touched.
 */
export async function categorizeSubscriptionAction(
  formData: FormData,
): Promise<SubscriptionCategorizeResult> {
  const parsed = merchantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) throw new Error("Invalid input");

  const outcome = fileSubscription(
    db,
    parsed.data.normalizedMerchant,
    subscriptionsCategoryId(),
  );

  // The spread order is deliberate: `outcome` first, warning second, so the
  // refusal/retarget sentences can never be clobbered by the refresh half.
  return { ...outcome, warning: revalidateAfterFiling() };
}

export async function categorizeAllSubscriptionsAction(): Promise<CategorizeAllSubscriptionsResult> {
  const outcome = fileAllSubscriptions(db, subscriptionsCategoryId());
  return { ...outcome, warning: revalidateAfterFiling() };
}

function subscriptionsCategoryId(): number {
  const row = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.name, "Subscriptions"))
    .get();
  if (!row) throw new Error("Subscriptions category not found");
  return row.id;
}

/**
 * `/categorize` and `/budget` are in here as well as the two obvious pages:
 * filing a subscription empties part of the uncategorized backlog and moves
 * spend into a category, and neither of those was revalidated before, so both
 * surfaces kept showing rows this action had already filed.
 *
 * Guarded, and returning `string | undefined` rather than `void`. This ran bare
 * after a COMMITTED `bulkCategorize`, so a throw from `revalidatePath` escaped
 * the action and rendered `/subscriptions/error.tsx` — discarding the whole
 * per-merchant outcome object on the way out. That object is not decoration
 * here: this page has no undo (rule 6), and `refusal` / `retargetedRule` are
 * the ONLY place the user is ever told that a hand-trained rule was withheld or
 * silently repointed. A refresh failure must not be able to swallow it.
 *
 * The guard lives here rather than at the two call sites so there is one place
 * to get it right, which is the same argument that put the try/catch in
 * `src/lib/revalidateAfterWrite.ts` rather than in seven route files.
 */
function revalidateAfterFiling(): string | undefined {
  return guardRefresh(SCOPE, () => {
    revalidatePath("/subscriptions");
    revalidatePath("/transactions");
    revalidatePath("/categorize");
    revalidatePath("/budget", "layout");
  });
}
