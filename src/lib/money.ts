/**
 * Format a signed integer cent amount as a USD string.
 *
 * Negatives render in accounting parens — `($42.00)` — per the Weekend 2 design
 * decision. Zero is rendered as `$0.00` without parens.
 */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const body = `$${(abs / 100).toFixed(2)}`;
  return cents < 0 ? `(${body})` : body;
}

/**
 * Parses a decimal amount string into signed integer cents via string math
 * — never `parseFloat(x) * 100`, which reintroduces binary-float error into
 * the one thing this app refuses to get wrong (CLAUDE.md rule 1).
 *
 * Originally SimpleFIN-only (the feed sends amounts as decimal strings like
 * "-178.97"); C4 moved it here and taught it to strip `$` and `,` so it can
 * also parse a human-typed budget allocation dollar amount, which
 * `upsertBudgetAllocationAction` previously ran through
 * `Math.round(Number(dollars) * 100)` — the exact anti-pattern rule 1 bans.
 * The sign is passed through untouched — SimpleFIN's signs are already
 * correct for the same reason the CSV's are (rule 2): nobody transformed
 * the data.
 */
export class AmountParseError extends Error {
  constructor(raw: unknown) {
    super(`Unparseable amount: ${JSON.stringify(raw)}`);
    this.name = "AmountParseError";
  }
}

const AMOUNT_RE = /^([+-]?)(\d+)(?:\.(\d*))?$/;

export function parseAmountToCents(raw: string): number {
  if (typeof raw !== "string") throw new AmountParseError(raw);
  const cleaned = raw.trim().replace(/[$,]/g, "");
  const match = AMOUNT_RE.exec(cleaned);
  if (!match) throw new AmountParseError(raw);

  const [, sign, whole, frac = ""] = match;
  const wholeCents = Number(whole) * 100;
  if (!Number.isSafeInteger(wholeCents)) throw new AmountParseError(raw);

  let cents = wholeCents + Number((frac + "00").slice(0, 2));
  // Round half away from zero on the third decimal. Star One always sends
  // exactly 2dp, but the spec permits more and silent truncation would leak
  // money over time.
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;

  return sign === "-" ? -cents : cents;
}

/**
 * Inverse of `parseAmountToCents` for round-tripping a magnitude into a plain
 * decimal string (e.g. for redisplaying a filter input's value). Cents are
 * assumed non-negative — callers filtering on magnitude never have a sign.
 */
export function centsToDollarString(cents: number): string {
  return (cents / 100).toFixed(2);
}
