import { z } from "zod";

/**
 * C3: upper bound on a single line's allocation. `year`/`month` two lines
 * down are both ranged; `allocatedCents` had no maximum, so a mistyped or
 * pasted value (an account number, a stray digit) produced a silently
 * accepted headline like `($4,183,200.00) over-budgeted` instead of a
 * visible inline error. $1M/line/month — every kind shares this bound via
 * the one schema below.
 */
export const ALLOCATE_MAX_CENTS = 100_000_000;

/**
 * Pure validation for `upsertBudgetAllocationAction` input. DB-free; the
 * Server Action wrapper runs this first, then enforces DB-bound rules
 * (parent-rejects-allocation, category existence) on top of the parsed data.
 *
 * Coerces strings → numbers so this composes directly with
 * `Object.fromEntries(formData)` in the Server Action.
 *
 * Year range 2000–2100 mirrors the `[year]/[month]/page.tsx` param schema
 * (review decision T5A) so both entry points reject the same garbage URLs.
 * `allocatedCents` is nonnegative: $0 is an explicit allocation, distinct
 * from "no row"; negatives are rejected.
 */
export const allocateInputSchema = z.object({
  categoryId: z.coerce.number().int().positive(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  allocatedCents: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(ALLOCATE_MAX_CENTS, { message: "Amounts over $1,000,000 aren't supported" }),
});

export type AllocateInput = z.infer<typeof allocateInputSchema>;

export type AllocateValidation =
  | { success: true; data: AllocateInput }
  | { success: false; error: z.ZodError };

export function validateAllocateInput(input: unknown): AllocateValidation {
  return allocateInputSchema.safeParse(input);
}
