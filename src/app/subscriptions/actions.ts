"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, schema } from "@/db";
import {
  fileAllSubscriptions,
  fileSubscription,
  type CategorizeAllSubscriptionsOutcome,
  type SubscriptionCategorizeOutcome,
} from "@/lib/subscriptions/categorizeSubscriptions";

const merchantSchema = z.object({
  normalizedMerchant: z.string().min(1).max(500),
});

export async function dismissSubscriptionAction(formData: FormData) {
  const parsed = merchantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) throw new Error("Invalid input");

  db.insert(schema.subscriptionDismissals)
    .values({ normalizedMerchant: parsed.data.normalizedMerchant })
    .onConflictDoNothing()
    .run();

  revalidatePath("/subscriptions");
}

export async function restoreSubscriptionAction(formData: FormData) {
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

  revalidatePath("/subscriptions");
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
): Promise<SubscriptionCategorizeOutcome> {
  const parsed = merchantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) throw new Error("Invalid input");

  const outcome = fileSubscription(
    db,
    parsed.data.normalizedMerchant,
    subscriptionsCategoryId(),
  );

  revalidateAfterFiling();
  return outcome;
}

export async function categorizeAllSubscriptionsAction(): Promise<CategorizeAllSubscriptionsOutcome> {
  const outcome = fileAllSubscriptions(db, subscriptionsCategoryId());
  revalidateAfterFiling();
  return outcome;
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
 */
function revalidateAfterFiling(): void {
  revalidatePath("/subscriptions");
  revalidatePath("/transactions");
  revalidatePath("/categorize");
  revalidatePath("/budget", "layout");
}
