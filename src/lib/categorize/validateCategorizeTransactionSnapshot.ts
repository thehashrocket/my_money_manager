import { z } from "zod";
import type { CategorizeTransactionSnapshot } from "./categorizeTransaction";

/**
 * Zod schema for a {@link CategorizeTransactionSnapshot}. Server Actions
 * receive this payload from the client when Undo is clicked, so the server
 * must not trust any field.
 *
 * React Server Actions preserve `Date` across the boundary, but we accept
 * either a `Date` or an ISO string for `priorRule.createdAt`/`updatedAt` to
 * survive JSON round-trips (e.g. if a caller sets the snapshot in
 * `localStorage` and replays it).
 */
const priorRuleSchema = z.object({
  id: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  matchType: z.enum(["exact", "contains", "regex"]),
  matchValue: z.string().min(1),
  priority: z.number().int(),
  source: z.enum(["auto", "manual"]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const categorizeTransactionSnapshotSchema = z.object({
  normalizedMerchant: z.string().min(1),
  newCategoryId: z.number().int().positive(),
  targetTxnId: z.number().int().positive(),
  targetPriorCategoryId: z.number().int().positive().nullable(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  applyToPastTxnIds: z.array(z.number().int().positive()),
  earliestApplyToPastDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .nullable(),
  ruleTouched: z.boolean(),
  priorRule: priorRuleSchema.nullable(),
}) satisfies z.ZodType<CategorizeTransactionSnapshot>;

export type CategorizeTransactionSnapshotValidation =
  | { success: true; data: CategorizeTransactionSnapshot }
  | { success: false; error: z.ZodError };

export function validateCategorizeTransactionSnapshot(
  input: unknown,
): CategorizeTransactionSnapshotValidation {
  return categorizeTransactionSnapshotSchema.safeParse(input);
}
