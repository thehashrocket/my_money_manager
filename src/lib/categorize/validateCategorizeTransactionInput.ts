import { z } from "zod";

/**
 * Pure validation for `categorizeTransactionAction` input. DB-free; the
 * Server Action runs this first, then DB-bound checks (txn exists, not a
 * transfer, category valid) inside the transaction.
 *
 * Coerces strings → numbers / booleans so this composes directly with
 * `Object.fromEntries(formData)`.
 *
 * `normalizedMerchant` is intentionally absent: the action reads the target
 * txn server-side and uses its stored merchant, so a tampered form can't
 * point "apply to past" at a different merchant than the target row.
 */
export const categorizeTransactionInputSchema = z.object({
  transactionId: z.coerce.number().int().positive(),
  categoryId: z.coerce.number().int().positive(),
  rememberMerchant: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
  applyToPast: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
});

export type CategorizeTransactionInput = z.infer<
  typeof categorizeTransactionInputSchema
>;

export type CategorizeTransactionValidation =
  | { success: true; data: CategorizeTransactionInput }
  | { success: false; error: z.ZodError };

export function validateCategorizeTransactionInput(
  input: unknown,
): CategorizeTransactionValidation {
  return categorizeTransactionInputSchema.safeParse(input);
}
