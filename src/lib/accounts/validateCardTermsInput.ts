import { z } from "zod";
import { optionalPositiveDollarsSchema } from "@/lib/import/accountAnchorFields";

/**
 * Pure validation for `updateCardTermsAction` — a card's credit limit and
 * minimum payment. DB-free; the Server Action runs this, then updates.
 *
 * These two were write-once at account creation, so a mistyped limit made the
 * utilization bar wrong on every render and the only repair was raw SQL.
 * `validateCreateAccountInput` already accepts them; this is the same shape
 * on the edit side, sharing `STARTING_BALANCE_DOLLARS_MAX` so creation and
 * repair cannot disagree about what magnitude is legal.
 *
 * `""` means CLEAR, not zero — see `optionalPositiveDollarsSchema`, which
 * both this and the creation path now share. `resolveUtilizationDisplay`
 * guards `creditLimitCents <= 0`, so a stored 0 correctly hides the bar; what
 * it costs is the DISTINCTION — the field then renders `0.00` instead of the
 * `none` placeholder, so "no limit recorded" and "a $0 limit" become
 * indistinguishable in the UI.
 */

export const cardTermsInputSchema = z
  .object({
    creditLimit: optionalPositiveDollarsSchema,
    minimumPayment: optionalPositiveDollarsSchema,
  })
  .transform((v) => ({
    creditLimitCents: v.creditLimit === null ? null : Math.round(v.creditLimit * 100),
    minimumPaymentCents: v.minimumPayment === null ? null : Math.round(v.minimumPayment * 100),
  }));

export type CardTermsInput = z.infer<typeof cardTermsInputSchema>;

export type CardTermsValidation =
  | { success: true; data: CardTermsInput }
  | { success: false; error: z.ZodError };

export function validateCardTermsInput(input: unknown): CardTermsValidation {
  return cardTermsInputSchema.safeParse(input);
}
