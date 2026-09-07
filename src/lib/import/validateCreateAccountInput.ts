import { z } from "zod";
import { accountClass } from "@/lib/accounts/accountClass";
import { isCreditCard } from "@/lib/accounts/isCreditCard";
import {
  isStartingBalanceCentsInBounds,
  optionalPositiveDollarsSchema,
  owedDollarsToSignedCents,
  startingBalanceDateSchema,
  startingBalanceDollarsSchema,
} from "./accountAnchorFields";

/**
 * Pure validation for `createAccountAction`. DB-free; the Server Action
 * wrapper runs this first, then inserts the parsed data.
 *
 * Bounds live in `accountAnchorFields.ts`, shared with every other writer of
 * an account's anchor — see that file's docstring for why.
 *
 * DS64 — THIS IS WHERE THE SIGN CONVENTION CAN SILENTLY CORRUPT THE LEDGER,
 * and it is why the sign math lives here rather than in the action. A
 * liability's balance is stored NEGATIVE (owing $2,000 is -200000), but the
 * user must never be asked to type a minus sign: the form says "Balance
 * owed", takes a positive number, and this schema negates it. Before that,
 * typing `2000` for a $2,000 Visa created the account with a POSITIVE anchor,
 * added $2,000 to the dashboard's Cash figure, and left net worth wrong by
 * $4,000 — with no error, no warning, and a number that looked plausible.
 *
 * Emitting `startingBalanceCents` rather than dollars is deliberate: it keeps
 * the sign decision at the boundary rather than in each caller. The negation
 * itself is `owedDollarsToSignedCents` in `accountAnchorFields.ts`, shared
 * with reconcile — this file used to own its own copy, and the two rounded
 * half-cents in opposite directions.
 */

const baseSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(100)),
  type: z.enum(["checking", "savings", "credit", "loan"]),
  startingBalance: startingBalanceDollarsSchema,
  startingBalanceDate: startingBalanceDateSchema,
  // Cards only (D2=A). Shared with the /accounts repair form so the two
  // cannot disagree about what magnitude is legal.
  creditLimit: optionalPositiveDollarsSchema,
  minimumPayment: optionalPositiveDollarsSchema,
});

export const createAccountInputSchema = baseSchema
  .superRefine((v, ctx) => {
    if (accountClass(v.type) === "liability" && v.startingBalance < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["startingBalance"],
        // DS61 register rule 1: state the consequence, not the rule. Rule 2:
        // never name a schema concept — no "anchor", no "starting balance".
        message: "Enter what you owe as a positive number.",
      });
    }
    // The bound is checked on the NEGATED cents, not on the typed dollars.
    //
    // `startingBalanceDollarsSchema` bounds what you type to [-$1M, $100M],
    // but a liability negates after that check — so a $2,000,000 loan passed
    // as a positive, then stored -200,000,000 cents, outside the range every
    // other anchor writer enforces. Worse, it was unrecoverable: reconcile
    // reshapes owed into -owed before `validateUpdateAnchorInput`, where
    // -2,000,000 < -1,000,000 fails, and reconcile is the ONLY path D15
    // allows for a liability balance. Creation could mint an account that
    // nothing in the app could ever correct.
    if (
      accountClass(v.type) === "liability" &&
      v.startingBalance >= 0 &&
      !isStartingBalanceCentsInBounds(owedDollarsToSignedCents(v.startingBalance))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["startingBalance"],
        message: "That balance is larger than this app accepts.",
      });
    }
    // D2=A: a mortgage row renders no utilization bar and no minimum payment,
    // so accepting either here would store a number nothing ever reads.
    if (!isCreditCard(v.type)) {
      if (v.creditLimit !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["creditLimit"],
          message: "A credit limit only applies to a credit card.",
        });
      }
      if (v.minimumPayment !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["minimumPayment"],
          message: "A minimum payment only applies to a credit card.",
        });
      }
    }
  })
  .transform((v) => {
    const isLiability = accountClass(v.type) === "liability";
    return {
      name: v.name,
      type: v.type,
      // Shared with reconcile via `owedDollarsToSignedCents`, so the two
      // paths cannot round a half-cent differently. See its docstring.
      startingBalanceCents: isLiability
        ? owedDollarsToSignedCents(v.startingBalance)
        : Math.round(v.startingBalance * 100),
      startingBalanceDate: v.startingBalanceDate,
      creditLimitCents: v.creditLimit === null ? null : Math.round(v.creditLimit * 100),
      minimumPaymentCents:
        v.minimumPayment === null ? null : Math.round(v.minimumPayment * 100),
    };
  });

export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

export type CreateAccountValidation =
  | { success: true; data: CreateAccountInput }
  | { success: false; error: z.ZodError };

export function validateCreateAccountInput(input: unknown): CreateAccountValidation {
  return createAccountInputSchema.safeParse(input);
}
