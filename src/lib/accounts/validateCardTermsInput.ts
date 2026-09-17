import { z } from "zod";
import { optionalPositiveDollarsSchema } from "@/lib/import/accountAnchorFields";

/**
 * Pure validation for `updateCardTermsAction` — a card's credit limit,
 * minimum payment, and paydown target. DB-free; the Server Action runs
 * this, then updates.
 *
 * The first two were write-once at account creation, so a mistyped limit made
 * the utilization bar wrong on every render and the only repair was raw SQL.
 * `validateCreateAccountInput` already accepts them; this is the same shape
 * on the edit side, sharing `STARTING_BALANCE_DOLLARS_MAX` so creation and
 * repair cannot disagree about what magnitude is legal. `paydownTarget`
 * (card-paydown-target plan) has no creation-time counterpart at all — it is
 * edit-only from the start, set whenever the user decides on a goal.
 *
 * `""` means CLEAR, not zero — see `optionalPositiveDollarsSchema`, which
 * this and the creation path share. `resolveUtilizationDisplay` guards
 * `creditLimitCents <= 0`, so a stored 0 correctly hides the bar; what it
 * costs is the DISTINCTION — the field then renders `0.00` instead of the
 * `none` placeholder, so "no limit recorded" and "a $0 limit" become
 * indistinguishable in the UI. The same distinction matters for
 * `paydownTargetCents`: a stored 0 would read as "goal: pay down nothing,"
 * a different claim than "no goal set."
 */

export const cardTermsInputSchema = z
  .object({
    creditLimit: optionalPositiveDollarsSchema,
    minimumPayment: optionalPositiveDollarsSchema,
    paydownTarget: optionalPositiveDollarsSchema,
  })
  .transform((v) => ({
    creditLimitCents: v.creditLimit === null ? null : Math.round(v.creditLimit * 100),
    minimumPaymentCents: v.minimumPayment === null ? null : Math.round(v.minimumPayment * 100),
    paydownTargetCents: v.paydownTarget === null ? null : Math.round(v.paydownTarget * 100),
  }));

export type CardTermsInput = z.infer<typeof cardTermsInputSchema>;

export type CardTermsValidation =
  | { success: true; data: CardTermsInput }
  | { success: false; error: z.ZodError };

export function validateCardTermsInput(input: unknown): CardTermsValidation {
  return cardTermsInputSchema.safeParse(input);
}
