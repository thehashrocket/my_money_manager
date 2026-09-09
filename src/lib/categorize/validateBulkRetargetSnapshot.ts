import { z } from "zod";
import type { BulkRetargetSnapshot } from "./bulkRetarget";

/**
 * Zod schema for a {@link BulkRetargetSnapshot}. The client stashes this for
 * the 10s Undo window and posts it back to `undoBulkRetargetAction`; the
 * server must not trust any field of it.
 *
 * Mirrors `validateBulkCategorizeSnapshot` field for field, including the two
 * decisions that were each a real bug there and would be the same bug here:
 * `matchType` is `z.literal("exact")` rather than the wide enum (a crafted
 * Undo could otherwise install `{matchType: "regex", matchValue: ".*"}` as a
 * catch-all rule), and neither `matchValue` nor `normalizedMerchant` carries
 * `.min(1)`, because `""` is a real stored key.
 *
 * `earliestDate` is non-nullable here where the sibling's is nullable:
 * `bulkRetarget` refuses an empty row set instead of returning one, so a
 * snapshot with no date is not a state this path can produce.
 */
const priorRuleSchema = z.object({
  id: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  matchType: z.literal("exact"),
  matchValue: z.string(),
  priority: z.number().int(),
  source: z.enum(["auto", "manual"]),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const bulkRetargetSnapshotSchema = z.object({
  normalizedMerchant: z.string(),
  fromCategoryId: z.number().int().positive(),
  categoryId: z.number().int().positive(),
  txnIds: z.array(z.number().int().positive()),
  ruleTouched: z.boolean(),
  priorRule: priorRuleSchema.nullable(),
  insertedRuleId: z.number().int().positive().nullable(),
  /* `z.iso.date()`, not a `^\d{4}-\d{2}-\d{2}$` regex — the same choice
     `startingBalanceDateSchema` documents (rule 1) and for a live reason
     here, not a stylistic one. This value is client round-tripped, and
     `undoBulkRetarget` feeds it straight to `parseIsoMonth`: a
     shape-valid but calendar-invalid `2026-13-01` yields month 13, so
     `invalidateForwardRollover` matches no `budget_periods` row and both
     categories' rows move back while their cached
     `effective_allocation_cents` stays stale for the rest of the year. */
  earliestDate: z.iso.date(),
}) satisfies z.ZodType<BulkRetargetSnapshot>;

export type BulkRetargetSnapshotValidation =
  | { success: true; data: BulkRetargetSnapshot }
  | { success: false; error: z.ZodError };

export function validateBulkRetargetSnapshot(
  input: unknown,
): BulkRetargetSnapshotValidation {
  return bulkRetargetSnapshotSchema.safeParse(input);
}
