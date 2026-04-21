import { z } from "zod";
import type { BulkCategorizeSnapshot } from "./bulkCategorize";

/**
 * Zod schema for a {@link BulkCategorizeSnapshot}. The client island stashes
 * this for the 10s Undo window and sends it back to
 * `undoBulkCategorizeAction`; the server must not trust any field.
 *
 * Dates survive JSON round-trips in `priorRule.createdAt`/`updatedAt` via
 * `z.coerce.date()` (mirrors `validateCategorizeTransactionSnapshot`).
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

export const bulkCategorizeSnapshotSchema = z.object({
  normalizedMerchant: z.string().min(1),
  categoryId: z.number().int().positive(),
  txnIds: z.array(z.number().int().positive()),
  ruleTouched: z.boolean(),
  priorRule: priorRuleSchema.nullable(),
  insertedRuleId: z.number().int().positive().nullable(),
  earliestDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .nullable(),
}) satisfies z.ZodType<BulkCategorizeSnapshot>;

export type BulkCategorizeSnapshotValidation =
  | { success: true; data: BulkCategorizeSnapshot }
  | { success: false; error: z.ZodError };

export function validateBulkCategorizeSnapshot(
  input: unknown,
): BulkCategorizeSnapshotValidation {
  return bulkCategorizeSnapshotSchema.safeParse(input);
}
