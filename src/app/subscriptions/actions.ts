"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, schema } from "@/db";
import { bulkCategorize } from "@/lib/categorize/bulkCategorize";
import { loadSubscriptions } from "@/lib/subscriptions/loadSubscriptions";

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

export async function categorizeSubscriptionAction(formData: FormData) {
  const parsed = merchantSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) throw new Error("Invalid input");

  const subscriptionsCategory = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.name, "Subscriptions"))
    .get();
  if (!subscriptionsCategory) throw new Error("Subscriptions category not found");

  bulkCategorize(db, {
    normalizedMerchant: parsed.data.normalizedMerchant,
    categoryId: subscriptionsCategory.id,
    rememberMerchant: true,
  });

  revalidatePath("/subscriptions");
  revalidatePath("/transactions");
}

export async function categorizeAllSubscriptionsAction() {
  const subscriptionsCategory = db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.name, "Subscriptions"))
    .get();
  if (!subscriptionsCategory) throw new Error("Subscriptions category not found");

  const { active } = loadSubscriptions(db);
  for (const sub of active) {
    bulkCategorize(db, {
      normalizedMerchant: sub.normalizedMerchant,
      categoryId: subscriptionsCategory.id,
      rememberMerchant: true,
    });
  }

  revalidatePath("/subscriptions");
  revalidatePath("/transactions");
}
