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
 *
 * ## When both directions validate
 *
 * A date whose transactions net to zero (a same-day paycheck and bill, say)
 * makes the running-balance chain validate in BOTH directions — nothing about
 * the math distinguishes true order from its reverse. Defaulting to "forward"
 * in that case is not a real answer, it's Star One's file order deciding a
 * real dollar amount: the same two rows, file order vs. reversed, have been
 * measured producing anchors that disagree. So both candidate orders are
 * checked against each other; if they agree on the resulting anchor it is
 * used, and if they disagree, derivation refuses rather than guess.
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

// Named so callers can distinguish "we had running-balance data but it didn't
// resolve" (worth telling the user about) from "no posted rows carried a
// balance at all" (the ordinary case for an all-pending or Balance-less
// import — not evidence anything is wrong). See `anchorStartingBalance` in
// importBatch.ts, the one caller that makes this distinction.
export const CHAIN_BROKEN_REASON = "running balance column does not form a consistent chain";
export const CHAIN_AMBIGUOUS_REASON =
  "running balance validates in both directions with disagreeing anchors — refusing to guess";

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

  const chain = chronologicalAscending(usable);
  if (!chain.ok) {
    return { ok: false, reason: chain.reason };
  }

  return anchorFromOrderedRows(chain.rows);
}

function anchorFromOrderedRows<
  T extends { date: string; balanceCents: number },
>(ascending: readonly T[]): { ok: true; date: string; startingBalanceCents: number } {
  const anchorDate = ascending[0].date;
  // Last row of that date in chronological order = the balance at its close.
  let closingBalanceCents = ascending[0].balanceCents;
  for (const r of ascending) {
    if (r.date !== anchorDate) break;
    closingBalanceCents = r.balanceCents;
  }

  return { ok: true, date: anchorDate, startingBalanceCents: closingBalanceCents };
}

type ChainResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

/**
 * Return the rows in true chronological order, or a failure reason if that
 * order cannot be established. Star One exports newest-first in practice;
 * both directions are tried so the derivation does not depend on that
 * holding. When both directions validate, they are also required to agree on
 * the resulting anchor — see the "When both directions validate" doc above.
 */
function chronologicalAscending<T extends { date: string; amountCents: number; balanceCents: number }>(
  rows: readonly T[],
): ChainResult<T> {
  const forward = [...rows];
  const backward = [...rows].reverse();
  const forwardValid = isValidChain(forward);
  const backwardValid = isValidChain(backward);

  if (forwardValid && backwardValid) {
    const forwardAnchor = anchorFromOrderedRows(forward);
    const backwardAnchor = anchorFromOrderedRows(backward);
    if (
      forwardAnchor.date === backwardAnchor.date &&
      forwardAnchor.startingBalanceCents === backwardAnchor.startingBalanceCents
    ) {
      return { ok: true, rows: forward };
    }
    return { ok: false, reason: CHAIN_AMBIGUOUS_REASON };
  }
  if (forwardValid) return { ok: true, rows: forward };
  if (backwardValid) return { ok: true, rows: backward };
  return {
    ok: false,
    reason: CHAIN_BROKEN_REASON,
  };
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
