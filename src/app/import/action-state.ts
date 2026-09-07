/**
 * The returned-state shape for `createAccountAction`.
 *
 * Deliberately NOT in `actions.ts`: a `"use server"` module may only export
 * async functions, so the `IDLE_CREATE_ACCOUNT` sentinel below — a plain
 * object, a real runtime value rather than an erased type — makes that file
 * fail to compile with `A "use server" file can only export async functions,
 * found object`. Same split `/accounts/action-state.ts` documents.
 *
 * WHY THIS EXISTS AT ALL: `createAccountAction` used to `throw` on a
 * validation failure. A thrown Server Action unmounts the whole route into
 * `import/error.tsx`, which renders a generic "Something went wrong loading
 * the import page" card — so DS61's carefully-worded messages ("Enter what
 * you owe as a positive number.") never reached anyone, and every field the
 * user had typed was destroyed on the way. `/accounts` made exactly this
 * decision under T28/E20 and wrote the rationale for it; the account-creation
 * form is the surface where losing typed input hurts most, because it is the
 * longest form in the app and the one a new user meets first.
 *
 * `field` drives `aria-invalid` on the offending input, so the error is
 * announced against the control rather than only as loose text.
 */
export type CreateAccountField =
  | "name"
  | "type"
  | "startingBalance"
  | "startingBalanceDate"
  | "creditLimit"
  | "minimumPayment";

export type CreateAccountState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string; field?: CreateAccountField };

export const IDLE_CREATE_ACCOUNT: CreateAccountState = { status: "idle" };
