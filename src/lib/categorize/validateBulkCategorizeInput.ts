import { z } from "zod";

/**
 * Pure validation for `bulkCategorizeMerchantAction` input. DB-free; the
 * Server Action wrapper runs this first, then DB-bound checks (category
 * exists, is a leaf, is not a savings goal) inside the transaction.
 *
 * Coerces strings → numbers / booleans so this composes directly with
 * `Object.fromEntries(formData)`.
 *
 * `normalizedMerchant` must be non-empty after trim. The merchant normalizer
 * is pure and already canonicalizes case/punctuation; we just refuse the
 * whitespace-only form here so the GROUP BY can't collapse onto an empty key.
 */
export const bulkCategorizeInputSchema = z.object({
  normalizedMerchant: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1)),
  categoryId: z.coerce.number().int().positive(),
  rememberMerchant: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
});

export type BulkCategorizeInput = z.infer<typeof bulkCategorizeInputSchema>;

export type BulkCategorizeValidation =
  | { success: true; data: BulkCategorizeInput }
  | { success: false; error: z.ZodError };

export function validateBulkCategorizeInput(
  input: unknown,
): BulkCategorizeValidation {
  return bulkCategorizeInputSchema.safeParse(input);
}
