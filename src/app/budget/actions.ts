"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { validateAllocateInput } from "@/lib/budget/validateAllocateInput";
import { upsertAllocation } from "@/lib/budget/upsertAllocation";
import { AmountParseError, parseAmountToCents } from "@/lib/money";

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
  // C4: parseAmountToCents (string math, $/,  stripping) replaces
  // `Math.round(Number(dollars) * 100)`, which CLAUDE.md rule 1 bans — the
  // same binary-float risk `parseFloat(x) * 100` has.
  if (raw.allocatedCents === undefined && raw.allocatedDollars !== undefined) {
    try {
      const dollars = String(raw.allocatedDollars);
      raw.allocatedCents = String(parseAmountToCents(dollars));
    } catch (err) {
      if (!(err instanceof AmountParseError)) throw err;
      // Leave allocatedCents unset; validateAllocateInput's zod schema
      // rejects the missing field with a coherent error message below.
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
