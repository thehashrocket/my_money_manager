import type { AccountType } from "./loadAccountBalances";

/**
 * Whether an account holds money you have or money you owe.
 *
 * Derived from `type` rather than stored as its own column, for the reason
 * DS59 states in one line: a stored column can disagree with `type`, a
 * function cannot. There is no migration that can leave these two out of
 * sync, and no write path that can forget to set it.
 *
 * The switch is exhaustive on purpose (failure mode F6). A future account
 * type — `investment`, say — must be a compile error here, not a silent
 * default to `asset`, because defaulting to `asset` is precisely the bug
 * that puts a debt into the dashboard's Cash figure and makes net worth
 * wrong by twice the balance with nothing on screen to say so.
 */
export type AccountClass = "asset" | "liability";

export function accountClass(type: AccountType): AccountClass {
  switch (type) {
    case "checking":
    case "savings":
      return "asset";
    case "credit":
    case "loan":
      return "liability";
    default: {
      const unreachable: never = type;
      throw new Error(`accountClass: unrecognized accounts.type ${JSON.stringify(unreachable)}`);
    }
  }
}
