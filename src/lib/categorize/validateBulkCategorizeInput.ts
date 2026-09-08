import { z } from "zod";

/**
 * Pure validation for `bulkCategorizeMerchantAction` input. DB-free; the
 * Server Action wrapper runs this first, then DB-bound checks (category
 * exists, is a leaf, is not a savings goal) inside the transaction.
 *
 * Coerces strings → numbers / booleans so this composes directly with
 * `Object.fromEntries(formData)`.
 *
 * `normalizedMerchant` is trimmed but MAY be empty, and that is the third and
 * last place this decision had to be applied consistently (the other two are
 * the snapshot validators). `""` is a real stored key — a blank bank memo
 * normalizes to it, `merchantLabel` exists to render it, and `loadMerchantGroups`
 * groups it like any other — so `/categorize` lists that group with a Submit
 * button, and `.min(1)` here made the button throw "Invalid bulk categorize
 * input" on the one group the user cannot fix any other way. It never protected
 * the GROUP BY it claimed to: the empty key comes OUT of that grouping rather
 * than being created by this input.
 */
export const bulkCategorizeInputSchema = z.object({
  normalizedMerchant: z.string().transform((s) => s.trim()),
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
