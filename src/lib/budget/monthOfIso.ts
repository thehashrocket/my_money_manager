/**
 * Parse an ISO `YYYY-MM-DD` date string into numeric year and month.
 *
 * Dates are stored as ISO text throughout the app (see CLAUDE.md). Several
 * categorize flows need (year, month) to call `invalidateForwardRollover`.
 * Centralized here so bulk + single-row callers stay in sync.
 */
export function parseIsoMonth(date: string): { year: number; month: number } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return { year, month };
}
