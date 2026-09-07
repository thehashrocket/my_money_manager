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

/**
 * `z.iso.date()` (not a plain YYYY-MM-DD regex) so a syntactically-shaped
 * but calendar-invalid date like `2026-13-40` is rejected here rather than
 * reaching `loadAccountBalances`'s lexicographic TEXT comparison, where it
 * would sort after every real date in the year and silently drop an
 * account's entire imported history out of the balance sum.
 */
export const startingBalanceDateSchema = z.iso.date();

/** True when a CSV-derived anchor (already in cents) is inside the legal range. */
export function isStartingBalanceCentsInBounds(cents: number): boolean {
  return (
    cents >= STARTING_BALANCE_CENTS_MIN && cents <= STARTING_BALANCE_CENTS_MAX
  );
}

/**
 * The ONE place a liability's "balance owed" becomes a signed `amount_cents`.
 *
 * Both write paths take a positive number from the user — account creation
 * (`validateCreateAccountInput`) and reconcile (`updateLiabilityBalanceAction`)
 * — and both have to negate it. They used to do that independently, and they
 * disagreed: create computed `-Math.round(owed * 100)` while reconcile
 * computed `Math.round(-owed * 100)`. `Math.round` breaks half-values toward
 * +Infinity, so the two differ by a cent on any half-cent input — `0.125`
 * gives -13 one way and -12 the other. A Server Action is reachable
 * regardless of the form's `step="0.01"`, so that was live, not theoretical.
 *
 * Rounding happens BEFORE the sign flip, always.
 *
 * The `magnitude !== 0` guard is for -0, which a paid-off card produces and
 * which is not `Object.is`-equal to 0. SQLite stores it as 0 either way, but
 * it survives in memory long enough to fail an equality assertion downstream
 * for a reason nobody would guess.
 */
export function owedDollarsToSignedCents(owedDollars: number): number {
  const magnitude = Math.round(owedDollars * 100);
  return magnitude === 0 ? 0 : -magnitude;
}

/**
 * A card's credit limit or minimum payment: optional, positive, in dollars.
 *
 * Shared by `validateCreateAccountInput` (where the value is first typed) and
 * `validateCardTermsInput` (where it is corrected). A second copy is exactly
 * how the two drift into disagreeing about what magnitude is legal — the same
 * failure `owedDollarsToSignedCents` was extracted to prevent one field over.
 *
 * `z.literal("")` must come FIRST: an untouched or emptied number input posts
 * "", and `z.coerce.number()` would read that as 0 — storing a $0 credit limit
 * rather than "no limit recorded". The two are different facts and the form
 * renders them differently (`0.00` in the field versus the `none`
 * placeholder), so collapsing them loses information the user entered.
 *
 * Trimmed first, because `Number(" ")` is also 0 and a whitespace-only value
 * would otherwise slip past the empty-string branch into that same trap.
 */
export const optionalPositiveDollarsSchema = z
  .preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.union([
      z.literal(""),
      z.coerce.number().finite().min(0).max(STARTING_BALANCE_DOLLARS_MAX),
    ]),
  )
  .nullish()
  .transform((v) => (v === "" || v === null || v === undefined ? null : v));
