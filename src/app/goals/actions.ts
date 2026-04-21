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

  db.insert(schema.categories)
    .values({ name, isSavingsGoal: true, targetCents, carryoverPolicy })
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
  if (!category.isSavingsGoal) throw new NotASavingsGoalError(categoryId);

  db.update(schema.categories)
    .set({ targetCents, updatedAt: new Date() })
    .where(eq(schema.categories.id, categoryId))
    .run();

  revalidatePath("/goals");
}
