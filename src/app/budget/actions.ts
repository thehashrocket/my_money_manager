"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { validateAllocateInput } from "@/lib/budget/validateAllocateInput";
import { upsertAllocation } from "@/lib/budget/upsertAllocation";
import { AmountParseError, parseAmountToCents } from "@/lib/money";
import { CategoryKindChangeRefusedError, setCategoryKind } from "@/lib/budget/setCategoryKind";
import { copyPreviousMonth, type CopyPreviousMonthResult } from "@/lib/budget/copyMonth";

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

const setCategoryKindInputSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  kind: z.enum(["income", "expense", "fund"]),
});

/**
 * A7: returns state instead of throwing. DS32's confirmation dialog renders
 * a refusal inline (with the same category the user was looking at, still
 * open) rather than losing that context to `error.tsx` — that boundary
 * stays as the backstop for anything genuinely unexpected, same posture as
 * `/sync`'s actions.
 */
export type SetCategoryKindActionState =
  | { status: "idle" }
  | { status: "ok"; categoryId: number }
  | { status: "error"; message: string };

export async function setCategoryKindAction(
  _prev: SetCategoryKindActionState,
  formData: FormData,
): Promise<SetCategoryKindActionState> {
  const parsed = setCategoryKindInputSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
    return { status: "error", message: `Invalid reclassify request — ${issues}` };
  }

  try {
    setCategoryKind(db, parsed.data.categoryId, parsed.data.kind);
  } catch (err) {
    if (err instanceof CategoryKindChangeRefusedError) {
      return { status: "error", message: err.message };
    }
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath("/budget");
  revalidatePath("/budget/[year]/[month]", "page");
  return { status: "ok", categoryId: parsed.data.categoryId };
}

const copyPreviousMonthInputSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/**
 * T16c/DS7 — called directly from a client transition (not a `<form
 * action>`), same pattern as `bulkCategorizeMerchantAction` on
 * `/categorize`: the caller wants the real `{copied, skipped,
 * skippedArchived}` counts to build its own Sonner toast message, not a
 * generic ok/error union.
 */
export async function copyPreviousMonthAction(year: number, month: number): Promise<CopyPreviousMonthResult> {
  const parsed = copyPreviousMonthInputSchema.parse({ year, month });
  const result = copyPreviousMonth(db, parsed.year, parsed.month);
  revalidatePath("/budget");
  revalidatePath("/budget/[year]/[month]", "page");
  return result;
}
