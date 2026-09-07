import { z } from "zod";
import { STARTING_BALANCE_DOLLARS_MAX } from "@/lib/import/accountAnchorFields";

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
 * `""` means CLEAR, not zero. An untouched or emptied number input posts an
 * empty string, and `z.coerce.number()` reads that as 0 — which
 * `resolveUtilizationDisplay` interprets as a card at 100% of no borrowing
 * power rather than as a card with no limit recorded. Same trap
 * `optionalPositiveDollars` documents on the creation side, and the reason
 * `z.literal("")` has to come first in the union.
 */
const optionalPositiveDollars = z
  .union([z.literal(""), z.coerce.number().finite().min(0).max(STARTING_BALANCE_DOLLARS_MAX)])
  .nullish()
  .transform((v) => (v === "" || v === null || v === undefined ? null : v));

export const cardTermsInputSchema = z
  .object({
    creditLimit: optionalPositiveDollars,
    minimumPayment: optionalPositiveDollars,
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
