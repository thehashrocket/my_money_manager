import { z } from "zod";

/**
 * Shared bounds for `(starting_balance_cents, starting_balance_date)`, the
 * pair every writer of an account's anchor has to agree on: account creation
 * (`validateCreateAccountInput`), the manual anchor-edit form
 * (`validateUpdateAnchorInput`), and CSV-derived auto-anchoring
 * (`anchorStartingBalance` in `importBatch.ts`). Letting these disagree about
 * what's a legal anchor is how one of them becomes the bug.
 *
 * Dollar bounds mirror the original v0.2.0 fix that closed `1e10` being
 * accepted by `Number.isFinite` alone. Upper bound is $100M — a single-user
 * local app with no 10-digit balances.
 */
export const STARTING_BALANCE_DOLLARS_MIN = -1_000_000;
export const STARTING_BALANCE_DOLLARS_MAX = 100_000_000;
export const STARTING_BALANCE_CENTS_MIN = STARTING_BALANCE_DOLLARS_MIN * 100;
export const STARTING_BALANCE_CENTS_MAX = STARTING_BALANCE_DOLLARS_MAX * 100;

/** `startingBalance` is a dollar amount (not cents) on every form that uses this. */
export const startingBalanceDollarsSchema = z.coerce
  .number()
  .finite()
  .min(STARTING_BALANCE_DOLLARS_MIN)
  .max(STARTING_BALANCE_DOLLARS_MAX);

export const startingBalanceDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** True when a CSV-derived anchor (already in cents) is inside the legal range. */
export function isStartingBalanceCentsInBounds(cents: number): boolean {
  return (
    cents >= STARTING_BALANCE_CENTS_MIN && cents <= STARTING_BALANCE_CENTS_MAX
  );
}
