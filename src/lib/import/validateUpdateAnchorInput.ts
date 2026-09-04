import { z } from "zod";
import { todayIso } from "@/lib/now";
import {
  startingBalanceDateSchema,
  startingBalanceDollarsSchema,
} from "./accountAnchorFields";

/**
 * Pure validation for `updateAccountAnchorAction`. DB-free; the Server Action
 * wrapper runs this first, then updates the parsed data.
 *
 * ## Why an account's anchor needs to be editable at all
 *
 * `anchorStartingBalance` (src/lib/importBatch.ts) only ever moves the anchor
 * FORWARD, and it is the sole writer of these columns outside account creation.
 * That makes a too-late anchor a one-way door: the balance rule sums only rows
 * dated strictly after it, so an account created with today's date has its
 * entire imported history excluded from its balance — and no subsequent CSV
 * import can correct it, because the date derived from a full-history file is
 * always earlier and the guard rejects it. Before this existed the only way out
 * was raw SQL against the container's volume. That is not an escape hatch a
 * single-user local app should require.
 *
 * The bounds come from the shared `accountAnchorFields.ts` deliberately: this
 * writes the same two columns `validateCreateAccountInput` does, and letting
 * the two paths disagree about what is a legal anchor is how one of them
 * becomes the bug.
 *
 * ## Why a future date is rejected outright (unlike the create-account path)
 *
 * This validator additionally rejects any date after today — a bound the
 * sibling `validateCreateAccountInput` doesn't have. A future anchor isn't
 * just wrong the way a calendar-invalid one is: `loadAccountBalances` sums
 * only rows dated strictly after the anchor, so a future anchor excludes
 * every real transaction and the balance freezes at whatever figure was
 * typed — and `classifyBalanceFreshness` can never call a bank figure
 * "conclusive" against a `ledgerAsOfDate` that's already in the future,
 * permanently silencing the drift check for that account too. This escape
 * hatch exists specifically to fix a bad anchor, so it doesn't get to
 * introduce a worse one.
 */
export const updateAnchorInputSchema = z.object({
  accountId: z.coerce.number().int().positive(),
  startingBalance: startingBalanceDollarsSchema,
  startingBalanceDate: startingBalanceDateSchema,
});

export type UpdateAnchorInput = z.infer<typeof updateAnchorInputSchema>;

export type UpdateAnchorValidation =
  | { success: true; data: UpdateAnchorInput }
  | { success: false; error: z.ZodError };

export function validateUpdateAnchorInput(
  input: unknown,
  now: Date = new Date(),
): UpdateAnchorValidation {
  const today = todayIso(now);
  return updateAnchorInputSchema
    .refine((data) => data.startingBalanceDate <= today, {
      message: "cannot be in the future — an anchor dates a balance you already know, not a projection",
      path: ["startingBalanceDate"],
    })
    .safeParse(input);
}
