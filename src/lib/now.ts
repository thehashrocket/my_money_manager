/**
 * Single source of "what is today, locally" for every server-side call site.
 *
 * `.toISOString()` always renders the UTC calendar date regardless of the
 * process `TZ` — so building a date string that way is wrong in exactly the
 * same way under any timezone. These helpers instead read local Date
 * component getters (`getFullYear`/`getMonth`/`getDate`), which Node derives
 * from `process.env.TZ` via ICU, so they move correctly with the container's
 * configured timezone. `src/components/ledger/spine-month.tsx` runs in the
 * browser and stays on its own client-side `new Date()` — it is already
 * correct for the visitor's real timezone and must not route through here.
 */

export type YearMonth = { year: number; month: number }; // month is 1-12

export function currentMonth(now: Date = new Date()): YearMonth {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * A `Date` rendered as its LOCAL calendar date, `YYYY-MM-DD`.
 *
 * Exported because comparing a bank-supplied instant against a ledger date
 * needs exactly this conversion: transactions are stored as local calendar
 * dates (CLAUDE.md, "Conventions"), so an instant has to be collapsed the same
 * way before the two can be ordered. `.toISOString().slice(0, 10)` is the wrong
 * tool — it renders the UTC date, which is off by one for any local evening.
 */
export function toLocalIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A `Date` rendered as local `YYYY-MM-DD HH:mm`, for displaying a timestamp
 * the app did not generate (a feed's `balance-date`). Minute precision: the
 * question it answers is "how stale is this", not "exactly when".
 */
export function formatLocalDateTime(d: Date): string {
  return `${toLocalIso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function todayIso(now: Date = new Date()): string {
  return toLocalIso(now);
}

export function daysAgoIso(days: number, now: Date = new Date()): string {
  // Built from local Y/M/D components, not `now.getTime() - days*86_400_000`:
  // instant arithmetic crosses local midnight at the wrong moment near a
  // timezone boundary, which is the exact bug this module exists to avoid.
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return toLocalIso(local);
}
