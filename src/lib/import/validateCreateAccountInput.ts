import { z } from "zod";

/**
 * Pure validation for `createAccountAction`. DB-free; the Server Action
 * wrapper runs this first, then inserts the parsed data.
 *
 * `startingBalance` is a dollar amount (not cents) because the user types it
 * into the form that way. Upper bound is $100M — a single-user local app with
 * no 10-digit balances, and refusing `1e10` closes the v0.2.0 P3 TODO where
 * `Number.isFinite` alone accepted it.
 *
 * `startingBalanceDate` must be ISO YYYY-MM-DD; anything else breaks the
 * `starting_balance_date` ledger invariant documented in CLAUDE.md.
 */
export const createAccountInputSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(100)),
  type: z.enum(["checking", "savings"]),
  startingBalance: z.coerce.number().finite().min(-1_000_000).max(100_000_000),
  startingBalanceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});

export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

export type CreateAccountValidation =
  | { success: true; data: CreateAccountInput }
  | { success: false; error: z.ZodError };

export function validateCreateAccountInput(
  input: unknown,
): CreateAccountValidation {
  return createAccountInputSchema.safeParse(input);
}
