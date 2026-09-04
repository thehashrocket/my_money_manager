"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import { CategoryNotFoundError, NotASavingsGoalError } from "@/lib/categoryErrors";
import { validateCreateGoal, validateUpdateGoalTarget } from "@/lib/goals/validateGoalInput";

export async function createGoalAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData);
  const result = validateCreateGoal(raw);
  if (!result.success) throw new Error(result.error);

  const { name, targetDollars, carryoverPolicy } = result.data;
  const targetCents = Math.round(targetDollars * 100);

  // Dual-write (T5, D1B/A2): kind is authoritative everywhere else in the
  // app now, but isSavingsGoal keeps being written so it stays truthful for
  // anything not yet migrated, until PR3 drops the column entirely.
  db.insert(schema.categories)
    .values({ name, isSavingsGoal: true, kind: "fund", targetCents, carryoverPolicy })
    .run();

  revalidatePath("/goals");
  redirect("/goals");
}

export async function updateGoalTargetAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData);
  const result = validateUpdateGoalTarget(raw);
  if (!result.success) throw new Error(result.error);

  const { categoryId, targetDollars } = result.data;
  const targetCents = Math.round(targetDollars * 100);

  const category = db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.id, categoryId))
    .get();

  if (!category) throw new CategoryNotFoundError(categoryId);
  // A2: kind is authoritative, not is_savings_goal (T5).
  if (category.kind !== "fund") throw new NotASavingsGoalError(categoryId);

  db.update(schema.categories)
    .set({ targetCents, updatedAt: new Date() })
    .where(eq(schema.categories.id, categoryId))
    .run();

  revalidatePath("/goals");
}
