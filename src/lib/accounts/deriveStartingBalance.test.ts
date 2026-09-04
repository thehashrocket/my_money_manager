import { describe, expect, it } from "vitest";
import {
  deriveStartingBalance,
  type StartingBalanceRow,
} from "./deriveStartingBalance";

function row(
  date: string,
  amountCents: number,
  balanceCents: number | null,
  isPending = false,
): StartingBalanceRow {
  return { date, amountCents, balanceCents, isPending };
}

/** Chronologically: -487 → 100000, -5210 → 94790, +120000 → 214790. */
const OLDEST_FIRST: StartingBalanceRow[] = [
  row("2026-04-16", -487, 100000),
  row("2026-04-17", -5210, 94790),
  row("2026-04-18", 120000, 214790),
];

describe("deriveStartingBalance", () => {
  it("anchors on the earliest date's closing balance, oldest-first", () => {
    expect(deriveStartingBalance(OLDEST_FIRST)).toEqual({
      ok: true,
      date: "2026-04-16",
      startingBalanceCents: 100000,
    });
  });

  it("reads a newest-first export the same way", () => {
    expect(deriveStartingBalance([...OLDEST_FIRST].reverse())).toEqual({
      ok: true,
      date: "2026-04-16",
      startingBalanceCents: 100000,
    });
  });

  // The balance rule is `anchor + SUM(amount WHERE date > anchor_date)` — a
  // strict `>`. Anchoring on the opening balance of the earliest day would drop
  // every same-day row from the total, so the anchor has to be the close.
  it("uses the last row of the earliest date, not the first", () => {
    const sameDay: StartingBalanceRow[] = [
      row("2026-04-16", -487, 100000),
      row("2026-04-16", -1000, 99000),
      row("2026-04-17", -5210, 93790),
    ];
    const derived = deriveStartingBalance(sameDay);
    expect(derived).toEqual({
      ok: true,
      date: "2026-04-16",
      startingBalanceCents: 99000,
    });

    // The rule reproduces the account's real closing balance.
    if (!derived.ok) throw new Error("unreachable");
    const sumAfter = sameDay
      .filter((r) => r.date > derived.date)
      .reduce((n, r) => n + r.amountCents, 0);
    expect(derived.startingBalanceCents + sumAfter).toBe(93790);
  });

  it("handles a single-row file", () => {
    expect(deriveStartingBalance([row("2026-04-16", -487, 100000)])).toEqual({
      ok: true,
      date: "2026-04-16",
      startingBalanceCents: 100000,
    });
  });

  it("ignores pending rows, which carry no running balance", () => {
    expect(
      deriveStartingBalance([
        row("2026-04-19", -2500, null, true),
        ...[...OLDEST_FIRST].reverse(),
      ]),
    ).toEqual({ ok: true, date: "2026-04-16", startingBalanceCents: 100000 });
  });

  // Rewriting the number every balance in the app is computed from, on a guess,
  // is worse than leaving it visibly wrong.
  it("refuses when the running balance does not chain", () => {
    const broken = [
      row("2026-04-16", -487, 100000),
      row("2026-04-17", -5210, 88888),
    ];
    expect(deriveStartingBalance(broken)).toEqual({
      ok: false,
      reason: "chain-broken",
    });
  });

  it("refuses when no row carries a balance", () => {
    expect(
      deriveStartingBalance([
        row("2026-04-16", -487, null),
        row("2026-04-17", -5210, null),
      ]),
    ).toEqual({ ok: false, reason: "no-balance-data" });
  });

  it("refuses on an empty file", () => {
    expect(deriveStartingBalance([])).toEqual({
      ok: false,
      reason: "no-balance-data",
    });
  });

  // Balances alone can chain in a shuffled file (identical amounts, identical
  // balances). Dates have to be monotonic in the chosen direction too, or the
  // "last row of the earliest date" is not actually the last row of that date.
  it("refuses when neither direction puts the dates in order", () => {
    expect(
      deriveStartingBalance([
        row("2026-04-16", 0, 100000),
        row("2026-04-18", 0, 100000),
        row("2026-04-17", 0, 100000),
      ]),
    ).toEqual({
      ok: false,
      reason: "chain-broken",
    });
  });

  // `parseCsv` flags a `6098` row as pending when its Balance column is blank
  // OR zero, so a pending row can carry a non-null 0. The filter keys on
  // `isPending`, not on the balance — keying on the balance alone would let
  // that 0 into the chain and break it for the whole file.
  it("excludes a pending row carrying a non-null zero balance", () => {
    expect(
      deriveStartingBalance([
        ...OLDEST_FIRST,
        row("2026-04-19", 2500, 0, true),
      ]),
    ).toEqual({ ok: true, date: "2026-04-16", startingBalanceCents: 100000 });
  });

  // A posted row with no balance is a hole in the chain, not something to skip
  // past: the rows either side of it no longer chain, so no anchor is derived.
  // Guessing here would rewrite the number every balance in the app is
  // computed from on incomplete data.
  it("refuses when a posted row in the middle has no balance", () => {
    expect(
      deriveStartingBalance([
        row("2026-04-16", -487, 100000),
        row("2026-04-17", -5210, null),
        row("2026-04-18", 120000, 214790),
      ]),
    ).toEqual({
      ok: false,
      reason: "chain-broken",
    });
  });

  // A same-day paycheck-and-bill pair nets to zero, so the running-balance
  // chain validates in BOTH file order and reversed — nothing about the math
  // says which is true. Picking "forward" anyway would let Star One's export
  // order (not evidence) decide a real dollar figure. Verified: these two
  // rows produce anchors $500 apart depending only on which order they're fed.
  it("refuses when both directions validate but disagree on the anchor", () => {
    const paycheckThenBill = [
      row("2026-04-16", 50000, 150000),
      row("2026-04-16", -50000, 100000),
    ];
    expect(deriveStartingBalance(paycheckThenBill)).toEqual({
      ok: false,
      reason: "chain-ambiguous",
    });
    // Same ambiguity, either way it's handed in.
    expect(deriveStartingBalance([...paycheckThenBill].reverse())).toEqual({
      ok: false,
      reason: "chain-ambiguous",
    });
  });

  // The disagree case above refuses; when both directions happen to validate
  // AND agree on the resulting (date, balance) pair — e.g. a same-day sequence
  // whose first and last balances coincide — there's no real ambiguity, and
  // this should succeed rather than trip the ambiguous-refusal path.
  it("succeeds when both directions validate and agree on the anchor", () => {
    const sameDayRoundTrip: StartingBalanceRow[] = [
      row("2026-04-16", -50000, 100000),
      row("2026-04-16", 50000, 150000),
      row("2026-04-16", -50000, 100000),
    ];
    expect(deriveStartingBalance(sameDayRoundTrip)).toEqual({
      ok: true,
      date: "2026-04-16",
      startingBalanceCents: 100000,
    });
    // Same agreement, either way it's handed in.
    expect(deriveStartingBalance([...sameDayRoundTrip].reverse())).toEqual({
      ok: true,
      date: "2026-04-16",
      startingBalanceCents: 100000,
    });
  });
});
