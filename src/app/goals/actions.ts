"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, schema } from "@/db";
import {
  CategoryArchivedError,
  CategoryNotFoundError,
  NotASavingsGoalError,
} from "@/lib/categoryErrors";
import { assertNameAvailable } from "@/lib/budget/manageCategories";
import { validateCreateGoal, validateUpdateGoalTarget } from "@/lib/goals/validateGoalInput";

export async function createGoalAction(formData: FormData): Promise<void> {
  const raw = Object.fromEntries(formData);
  const result = validateCreateGoal(raw);
  if (!result.success) throw new Error(result.error);

  const { name, targetDollars, carryoverPolicy } = result.data;
  const targetCents = Math.round(targetDollars * 100);

  // `categories.name` is globally unique, and this action used to insert with
  // no check at all — so a collision surfaced as a raw
  // `UNIQUE constraint failed: categories.name`, which the shipped build
  // replaces with a generic digest. `createCategory` (the other fund-creation
  // path, /budget's "+ Add a line") has always checked, so the two surfaces
  // disagreed about the same collision; they now share one function rather
  // than each carrying their own copy of the query. The archived case is why
  // this became worth fixing now: v0.24.0 filters archived funds out of
  // `loadGoals`, so the colliding category is no longer visible on the page
  // the user is standing on.
  assertNameAvailable(db, name);

  // Dual-write (T5, D1B/A2): kind is authoritative everywhere else in the
  // app now, but isSavingsGoal keeps being written so it stays truthful for
  // anything not yet migrated, until PR3 drops the column entirely.
  db.insert(schema.categories)
    .values({ name, isSavingsGoal: true, kind: "fund", targetCents, carryoverPolicy })
    .run();

  // `/budget` too, since D3=C: the FUNDS band renders this fund's row and
  // its `targetCents` ("Left to target"). A fund created here and not
  // revalidated there is missing from the band — and when it is the FIRST
  // fund, the band itself does not render, because `<MonthEditor>` gates
  // the whole section on `fundRows.length > 0`.
  revalidatePath("/goals");
  revalidatePath("/budget");
  revalidatePath("/budget/[year]/[month]", "page");
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
  // v0.24.0 dropped archived funds from `loadGoals`, which turned an already
  // odd write into an invisible one: a tab opened before the fund was archived
  // still renders its "Edit target" form, and submitting it used to succeed
  // against a fund the page can no longer show. `upsertAllocation` already
  // refuses an archived category for the same reason (a write whose result is
  // unreadable is worse than a refusal); this is the matching guard on the
  // other quantity `/budget`'s FUNDS band reads from this row.
  if (category.archivedAt !== null) {
    throw new CategoryArchivedError(categoryId, category.name);
  }

  db.update(schema.categories)
    .set({ targetCents, updatedAt: new Date() })
    .where(eq(schema.categories.id, categoryId))
    .run();

  // `/budget` reads this same target for the band's "Left to target"
  // column (`fundTargetGap`), so a target changed here has to invalidate
  // there or the gap keeps reporting against the old number.
  revalidatePath("/goals");
  revalidatePath("/budget");
  revalidatePath("/budget/[year]/[month]", "page");
}
