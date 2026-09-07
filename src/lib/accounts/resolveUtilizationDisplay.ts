export type UtilizationDisplay = {
  /** 0-100, capped. Meaningless when `hasLimit` is false. */
  pct: number;
  /** False when no credit limit is recorded — render no bar at all. */
  hasLimit: boolean;
};

/**
 * How much of a card's limit is currently used.
 *
 * `balanceCents` arrives negative (owing $2,148 is -214800) and
 * `creditLimitCents` positive, so the ratio is taken over the magnitude of
 * the debt. A zero or positive balance is 0% used — a paid-off or overpaid
 * card has consumed none of its limit.
 *
 * DS62 — THE BAR IS ALWAYS TERRACOTTA AND HAS NO WARN THRESHOLD. An "your
 * utilization is high" state would be financial advice, which is the one
 * thing deliberately cut from every generated mockup, and `--accent-amber`
 * already carries eight distinct meanings per DESIGN.md's own amber
 * inventory. 43% utilized is not a warning and must not add a ninth.
 *
 * This is a module rather than a ternary in JSX for two reasons: computing it
 * inline would recreate, inside the very PR that deletes two such
 * duplications (D8, D9), the same class of drifted copy; and CLAUDE.md scopes
 * tests to logic, so a rule written in JSX is a rule this repo cannot test.
 */
export function resolveUtilizationDisplay(
  balanceCents: number,
  creditLimitCents: number | null,
): UtilizationDisplay {
  // A non-positive limit is as uninformative as no limit at all, and would
  // divide by zero besides.
  if (creditLimitCents === null || creditLimitCents <= 0) return { pct: 0, hasLimit: false };

  const owed = balanceCents < 0 ? -balanceCents : 0;
  const raw = (owed / creditLimitCents) * 100;

  // Over-limit is real (fees, interest posting past the limit) and caps at
  // 100 because a bar cannot show 118% — the caption beside it carries the
  // true figures, exactly as the budget rows do with their overflow tick.
  return { pct: Math.min(100, raw), hasLimit: true };
}
