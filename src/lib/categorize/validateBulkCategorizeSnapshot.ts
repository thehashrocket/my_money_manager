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
  /**
   * `z.literal`, not the full enum. The only rows that reach a snapshot come
   * from `readExactRule`/`deleteExactRule`, and `restorePriorRule` INSERTs the
   * snapshot verbatim — so accepting the wide enum let a crafted Undo payload
   * install `{matchType: "regex", matchValue: ".*"}` as a catch-all rule.
   * Mirrors the narrowed `PriorRuleSnapshot.matchType`.
   */
  matchType: z.literal("exact"),
  /**
   * No `.min(1)`. The empty key is a legitimate value everywhere else in this
   * codebase — a blank bank memo normalizes to `""` (`merchantLabel` exists for
   * exactly that), `/transactions` resolves the key server-side from the row, and
   * a refusal on `""` now DELETES that key's rule. Rejecting it here made the
   * undo of the one action with no other repair path throw
   * "Invalid undo snapshot".
   */
  matchValue: z.string(),
  priority: z.number().int(),
  source: z.enum(["auto", "manual"]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const bulkCategorizeSnapshotSchema = z.object({
  /** No `.min(1)` — see `priorRuleSchema.matchValue`; `""` is a real key. */
  normalizedMerchant: z.string(),
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
