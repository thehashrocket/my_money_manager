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
     `startingBalanceDateSchema` documents (rule 1).

     Its original reason is gone and is worth recording as gone rather than
     quietly restating: this fed `parseIsoMonth` → `invalidateForwardRollover`,
     where a calendar-invalid `2026-13-01` matched no `budget_periods` row and
     left a rollover cache stale for the rest of the year. That cache no
     longer exists, and NOTHING now consumes `earliestDate` — it is still
     produced by `bulkRetarget` and round-tripped through the client, but
     every reader was an invalidation call.

     It stays validated anyway, deliberately. A field a client can hand back
     is part of this schema's contract whether or not today's code reads it,
     and a schema that accepts `2026-13-01` for a field it carries is a trap
     set for whoever adds the next reader. Removing the field outright is the
     honest end state and is tracked in TODOS.md — it changes the undo wire
     format, which is a different risk from deleting a cache and does not
     belong in the same change. */
  earliestDate: z.iso.date(),
}) satisfies z.ZodType<BulkRetargetSnapshot>;

/**
 * The two CROSS-FIELD facts, which the object shape alone cannot carry.
 *
 * 1. `priorRule.matchValue === normalizedMerchant`. `undoBulkRetarget`'s row
 *    UPDATE is bounded by the merchant for exactly this reason (see the long
 *    comment there), but `restorePriorRule` got no equivalent — and its third
 *    mechanism is `onConflictDoUpdate` on `(match_type, match_value)`, which
 *    REPOINTS whatever rule currently occupies that slot at the snapshot's
 *    category. So a hand-edited payload could retarget an arbitrary merchant's
 *    rule to an arbitrary category, and — because the restore deliberately
 *    writes `updatedAt` back to influence `compareRules`' tie-break — reorder
 *    rule priority while doing it. Rows bounded and rules unbounded, in one
 *    function. This closes the half that was open.
 *
 * 2. `fromCategoryId !== categoryId`. A same-category snapshot degenerates to
 *    a no-op UPDATE today, but it is a contradiction on its face and the
 *    forward path refuses it (`SameCategoryRetargetError`); the undo should
 *    not accept a shape its own producer cannot emit.
 */
export const bulkRetargetSnapshotSchemaChecked = bulkRetargetSnapshotSchema
  .refine(
    (s) => s.priorRule === null || s.priorRule.matchValue === s.normalizedMerchant,
    {
      path: ["priorRule", "matchValue"],
      message:
        "priorRule belongs to a different merchant than the snapshot it is attached to",
    },
  )
  .refine((s) => s.fromCategoryId !== s.categoryId, {
    path: ["fromCategoryId"],
    message: "source and destination categories are the same",
  });

export type BulkRetargetSnapshotValidation =
  | { success: true; data: BulkRetargetSnapshot }
  | { success: false; error: z.ZodError };

export function validateBulkRetargetSnapshot(
  input: unknown,
): BulkRetargetSnapshotValidation {
  return bulkRetargetSnapshotSchemaChecked.safeParse(input);
}
