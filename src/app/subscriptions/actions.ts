"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db, schema } from "@/db";

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
