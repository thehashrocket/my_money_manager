import { z } from "zod";
import {
  startingBalanceDateSchema,
  startingBalanceDollarsSchema,
} from "./accountAnchorFields";

/**
 * Pure validation for `createAccountAction`. DB-free; the Server Action
 * wrapper runs this first, then inserts the parsed data.
 *
 * Bounds live in `accountAnchorFields.ts`, shared with every other writer of
 * an account's anchor — see that file's docstring for why.
 */
export const createAccountInputSchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(100)),
  type: z.enum(["checking", "savings"]),
  startingBalance: startingBalanceDollarsSchema,
  startingBalanceDate: startingBalanceDateSchema,
});

export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;

export type CreateAccountValidation =
  | { success: true; data: CreateAccountInput }
  | { success: false; error: z.ZodError };

export function validateCreateAccountInput(
  input: unknown,
): CreateAccountValidation {
  return createAccountInputSchema.safeParse(input);
}
