"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { validateAllocateInput } from "@/lib/budget/validateAllocateInput";
import { upsertAllocation } from "@/lib/budget/upsertAllocation";

/**
 * Create or update a single leaf category's allocation for a given month.
 *
 * Thin wrapper around `validateAllocateInput` (pure) + `upsertAllocation`
 * (DB-bound): parse FormData → validate shape → run upsert + forward
 * invalidation in a transaction → revalidate → redirect. Follows the
 * redirect-outside-try/catch pattern from `src/app/import/actions.ts`.
 *
 * Validation failures, unknown categories, and parent-category rejects
 * throw `Error`; Next.js renders them via the route's `error.tsx`.
 */
export async function upsertBudgetAllocationAction(
  formData: FormData,
): Promise<void> {
  const raw: Record<string, FormDataEntryValue> = Object.fromEntries(formData);
  // UX: inline form submits dollars (e.g. "40.00"); storage unit is cents.
  // Convert before validation if the caller didn't already provide cents.
  if (raw.allocatedCents === undefined && raw.allocatedDollars !== undefined) {
    const dollars = Number(raw.allocatedDollars);
    if (Number.isFinite(dollars)) {
      raw.allocatedCents = String(Math.round(dollars * 100));
    }
    delete raw.allocatedDollars;
  }

  const parsed = validateAllocateInput(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid allocation input — ${issues}`);
  }

  upsertAllocation(db, parsed.data);

  const { year, month } = parsed.data;
  revalidatePath("/budget");
  revalidatePath(`/budget/${year}/${month}`);
  redirect(`/budget/${year}/${month}`);
}
