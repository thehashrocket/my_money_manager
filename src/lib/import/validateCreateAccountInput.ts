import { z } from "zod";
import { accountClass } from "@/lib/accounts/accountClass";
import {
  STARTING_BALANCE_DOLLARS_MAX,
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
 * exactly one place in the codebase where an account's opening sign is
 * decided, and that place has tests.
 */

/** Cards only (D2=A). Optional; `""` from an untouched form field is NULL. */
const optionalPositiveDollars = z
  // `z.literal("")` must come FIRST: an untouched number input posts "", and
  // z.coerce.number() would happily read that as 0 — storing a $0 credit
  // limit, which resolveUtilizationDisplay reads as a card at 100% of no
  // borrowing power rather than as a card with no limit recorded.
  .union([z.literal(""), z.coerce.number().finite().min(0).max(STARTING_BALANCE_DOLLARS_MAX)])
  .nullish()
  .transform((v) => (v === "" || v === null || v === undefined ? null : v));

const baseSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(100)),
  type: z.enum(["checking", "savings", "credit", "loan"]),
  startingBalance: startingBalanceDollarsSchema,
  startingBalanceDate: startingBalanceDateSchema,
  creditLimit: optionalPositiveDollars,
  minimumPayment: optionalPositiveDollars,
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
    // D2=A: a mortgage row renders no utilization bar and no minimum payment,
    // so accepting either here would store a number nothing ever reads.
    if (v.type !== "credit") {
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
    const magnitude = Math.round(v.startingBalance * 100);
    // `magnitude !== 0` guards against -0, which a paid-off card produces and
    // which is not `Object.is`-equal to 0. SQLite would store it as 0 either
    // way, but it would survive in memory long enough to make an equality
    // assertion somewhere downstream fail for a reason nobody would guess.
    const negate = accountClass(v.type) === "liability" && magnitude !== 0;
    return {
      name: v.name,
      type: v.type,
      // The one negation in the app's account-creation path.
      startingBalanceCents: negate ? -magnitude : magnitude,
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
