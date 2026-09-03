/**
 * Derive an account's starting-balance anchor from a Star One CSV's running
 * `Balance` column.
 *
 * Why this exists: an account is created with whatever starting balance the
 * user types, and both real accounts were created with 0. Every displayed
 * balance is therefore net-change-since-signup rather than a balance, and once
 * the account is linked, `/sync`'s drift check compares that fabricated figure
 * against the bank's real one and reports "a row is missing or duplicated"
 * permanently — the app's only integrity signal, crying wolf from day one.
 *
 * The CSV already carries the answer: `parseCsv` reads the running balance on
 * every row and, before this, used it only to spot pending rows.
 *
 * ## Which (date, balance) pair is the anchor
 *
 * The balance rule is `starting_balance_cents + SUM(amount_cents WHERE date >
 * starting_balance_date)` — a STRICT `>`, so every row dated on the anchor date
 * is excluded from the sum. The anchor must therefore be the balance at the
 * *close* of its date, not the opening balance: anchoring at the opening
 * balance would drop every same-day row from the total.
 *
 * ## Why the row order has to be established rather than assumed
 *
 * Picking "the closing balance of the earliest date" needs to know which row of
 * that date came last, and Star One's export order is not a documented
 * guarantee. So it is verified instead: a running-balance column is a chain —
 * each row's balance is the previous row's plus this row's amount — and that
 * chain only validates in the true chronological order. If neither direction
 * validates (a gappy export, a file assembled by hand, a missing Balance
 * column), no anchor is derived and the account is left exactly as it was.
 * Rewriting the number that every balance in the app is computed from, on a
 * guess, is worse than leaving it wrong in a way the user already knows about.
 */

export type StartingBalanceRow = {
  date: string;
  amountCents: number;
  balanceCents: number | null;
  isPending: boolean;
};

export type StartingBalanceDerivation =
  | { ok: true; date: string; startingBalanceCents: number }
  | { ok: false; reason: string };

export function deriveStartingBalance(
  rows: readonly StartingBalanceRow[],
): StartingBalanceDerivation {
  // Pending rows carry no balance — Star One leaves the column blank (or 0)
  // until the row posts, which is exactly what `parseCsv` keys the pending
  // heuristic on. They are not yet part of the running balance, so dropping
  // them leaves the chain across the remaining rows intact.
  const usable = rows.filter(
    (r): r is StartingBalanceRow & { balanceCents: number } =>
      !r.isPending && r.balanceCents !== null,
  );

  if (usable.length === 0) {
    return { ok: false, reason: "no posted rows with a running balance" };
  }

  const ascending = chronologicalAscending(usable);
  if (!ascending) {
    return {
      ok: false,
      reason: "running balance column does not form a consistent chain",
    };
  }

  const anchorDate = ascending[0].date;
  // Last row of that date in chronological order = the balance at its close.
  let closingBalanceCents = ascending[0].balanceCents;
  for (const r of ascending) {
    if (r.date !== anchorDate) break;
    closingBalanceCents = r.balanceCents;
  }

  return { ok: true, date: anchorDate, startingBalanceCents: closingBalanceCents };
}

/**
 * Return the rows in true chronological order, or `null` if that order cannot
 * be established. Star One exports newest-first in practice; both directions
 * are tried so the derivation does not depend on that holding.
 */
function chronologicalAscending<T extends { date: string; amountCents: number; balanceCents: number }>(
  rows: readonly T[],
): T[] | null {
  const forward = [...rows];
  const backward = [...rows].reverse();

  if (isValidChain(forward)) return forward;
  if (isValidChain(backward)) return backward;
  return null;
}

function isValidChain(
  seq: readonly { date: string; amountCents: number; balanceCents: number }[],
): boolean {
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].balanceCents !== seq[i - 1].balanceCents + seq[i].amountCents) {
      return false;
    }
    // A validating chain whose dates run backwards is not chronological order,
    // it is a coincidence. Reject rather than anchor on it.
    if (seq[i].date < seq[i - 1].date) return false;
  }
  return true;
}
