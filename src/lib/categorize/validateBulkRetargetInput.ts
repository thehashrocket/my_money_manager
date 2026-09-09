import { z } from "zod";

/**
 * Pure validation for `bulkRetargetAction` input. DB-free; the Server Action
 * wrapper runs this first, then the DB-bound checks (both categories exist,
 * the destination is an assignable leaf, the source still has rows) inside
 * `bulkRetarget`.
 *
 * Coerces strings → numbers / booleans so this composes directly with
 * `Object.fromEntries(formData)`, exactly like its two siblings.
 *
 * `normalizedMerchant` is trimmed but MAY be empty — the same decision
 * `validateBulkCategorizeInput` documents at length. `""` is a real stored key
 * (a blank bank memo normalizes to it), it groups and files like any other,
 * and a `.min(1)` here would make the one group with no other repair path
 * throw on the repair.
 *
 * `fromCategoryId` is a real category id and never `"none"`: this path moves
 * rows that are already FILED. Moving uncategorized rows is what
 * `bulkCategorize` is for, and conflating the two would give one action two
 * different undo semantics.
 */
export const bulkRetargetInputSchema = z.object({
  /** No `.min(1)` — see the note above; `""` is a real key. */
  normalizedMerchant: z.string().transform((s) => s.trim()),
  /** The category the rows are filed under NOW. */
  fromCategoryId: z.coerce.number().int().positive(),
  /** The category they are being moved TO. Named to match its siblings. */
  categoryId: z.coerce.number().int().positive(),
  rememberMerchant: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .transform((v) => v === true || v === "true")
    .default(false),
});

export type BulkRetargetInput = z.infer<typeof bulkRetargetInputSchema>;

export type BulkRetargetValidation =
  | { success: true; data: BulkRetargetInput }
  | { success: false; error: z.ZodError };

export function validateBulkRetargetInput(
  input: unknown,
): BulkRetargetValidation {
  return bulkRetargetInputSchema.safeParse(input);
}
