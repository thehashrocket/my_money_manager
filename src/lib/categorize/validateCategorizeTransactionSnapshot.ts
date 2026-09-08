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

export const categorizeTransactionSnapshotSchema = z.object({
  /** No `.min(1)` — see `priorRuleSchema.matchValue`; `""` is a real key. */
  normalizedMerchant: z.string(),
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
  insertedRuleId: z.number().int().positive().nullable(),
}) satisfies z.ZodType<CategorizeTransactionSnapshot>;

export type CategorizeTransactionSnapshotValidation =
  | { success: true; data: CategorizeTransactionSnapshot }
  | { success: false; error: z.ZodError };

export function validateCategorizeTransactionSnapshot(
  input: unknown,
): CategorizeTransactionSnapshotValidation {
  return categorizeTransactionSnapshotSchema.safeParse(input);
}
