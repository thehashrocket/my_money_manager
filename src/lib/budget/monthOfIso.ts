import { currentMonth } from "@/lib/now";

export type YearMonth = { year: number; month: number };

/**
 * Parse an ISO `YYYY-MM-DD` date string into numeric year and month.
 *
 * Dates are stored as ISO text throughout the app (see CLAUDE.md). Several
 * categorize flows need (year, month) to call `invalidateForwardRollover`.
 * Centralized here so bulk + single-row callers stay in sync.
 */
export function parseIsoMonth(date: string): YearMonth {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return { year, month };
}

/**
 * D4A: this file is the one home for month arithmetic. Before this, the
 * same handful of lines were copy-pasted verbatim across budget.ts,
 * loadMonthView.ts, loadMonthlyTrends.ts, loadTransactions.ts and (as
 * `shiftMonth`) the budget page — six variants of the same three lines,
 * each one a chance to get the December rollover wrong differently.
 */

export function previousMonth(year: number, month: number): YearMonth {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

export function nextMonthOf(year: number, month: number): YearMonth {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

export function nMonthsBack(year: number, month: number, n: number): YearMonth {
  let y = year;
  let m = month - n;
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  return { year: y, month: m };
}

export function monthBoundary(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

export type MonthPhase = "future" | "open" | "closed";

/**
 * Where a (year, month) sits relative to the current local month (E12).
 *
 * Replaces the `monthHasStarted`/`monthHasEnded` boolean pair that
 * `resolveRowDisplay` was heading toward: that pair had no producer anywhere
 * in `src/` (the comparison would otherwise have been written inline in a
 * component, where CLAUDE.md bans testing it), and it could express an
 * impossible fourth state (`started=false && ended=true`). Three states,
 * one of which is always true.
 *
 * Reads the clock through `currentMonth` (local Date component getters, not
 * `.toISOString()`) so the boundary follows `process.env.TZ` rather than
 * UTC — the exact bug `src/lib/now.ts` exists to prevent, and the reason
 * CLAUDE.md makes the Docker container refuse to boot without `TZ` set.
 */
export function monthPhase(year: number, month: number, now: Date = new Date()): MonthPhase {
  const current = currentMonth(now);
  const targetIndex = year * 12 + month;
  const currentIndex = current.year * 12 + current.month;
  if (targetIndex < currentIndex) return "closed";
  if (targetIndex > currentIndex) return "future";
  return "open";
}
