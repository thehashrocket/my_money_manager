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
      reason: "running balance column does not form a consistent chain",
    });
  });

  it("refuses when no row carries a balance", () => {
    expect(
      deriveStartingBalance([
        row("2026-04-16", -487, null),
        row("2026-04-17", -5210, null),
      ]),
    ).toEqual({ ok: false, reason: "no posted rows with a running balance" });
  });

  it("refuses on an empty file", () => {
    expect(deriveStartingBalance([])).toEqual({
      ok: false,
      reason: "no posted rows with a running balance",
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
      reason: "running balance column does not form a consistent chain",
    });
  });
});
