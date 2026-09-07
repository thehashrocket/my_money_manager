const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format a signed integer cent amount as a USD string.
 *
 * Negatives render in accounting parens — `($42.00)` — per the Weekend 2 design
 * decision. Zero is rendered as `$0.00` without parens.
 *
 * Thousands ARE grouped: `($302,480.11)`. This used to be a bare
 * `.toFixed(2)`, which rendered `($302480.11)` — DESIGN.md's own money-display
 * examples have always shown `($1,204.50)`, so the formatter and the design
 * doc disagreed. Nothing under four figures made it visible, which is exactly
 * why it survived; a mortgage balance makes it unreadable at a glance.
 * `Intl.NumberFormat` is instantiated once at module scope — constructing one
 * per call is the expensive part, and this runs per row.
 */
export function formatCents(cents: number): string {
  const body = USD.format(Math.abs(cents) / 100);
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

/* ------------------------------------------------------------------------ *
 * Money tone — the sign→color-token rule, in one place (D9)
 * ------------------------------------------------------------------------ */

/**
 * Which money color a figure should carry.
 *
 * `neutral` and `plain` are genuinely different and the difference is
 * load-bearing for liabilities: `neutral` is `--money-zero` (= `--ink-3`,
 * deliberately quiet, for a $0.00), while `plain` is full-strength body ink
 * for a number that is *supposed* to be negative and must not be dressed as
 * either an alarm or an afterthought.
 */
export type MoneyTone = "positive" | "negative" | "neutral" | "plain";

/**
 * Whether a negative figure means "something went wrong" (an asset account
 * overdrawn, an envelope overspent) or "this is working as intended" (a
 * liability balance — owing money is the entire point of the account).
 */
export type MoneyContext = "asset" | "liability";

export const MONEY_TONE_CLASS: Record<MoneyTone, string> = {
  positive: "text-money-pos",
  negative: "text-money-neg",
  neutral: "text-money-zero",
  plain: "text-foreground",
};

/**
 * The sign→tone rule, extracted (D9) because it was written six times and had
 * already diverged once — `spine.tsx` emitted the bare `money-neg` CSS class
 * where every other site used the `text-money-neg` utility. Identical output
 * (`.money-neg` and `text-money-neg` both resolve to `var(--money-neg)`), but
 * two vocabularies for one rule is how the seventh copy gets written wrong.
 *
 * A liability's balance is stored negative (owing $2,000 is `-200000`), so
 * running it through the asset rule would paint every credit card and the
 * mortgage in `--accent-redbrown` permanently — an alarm that can never be
 * cleared is not an alarm, it is just a red page. In `liability` context only
 * a *positive* balance is remarkable: that is a credit balance, money the
 * lender owes you.
 *
 * DS59's muted long-term treatment is deliberately NOT here. It keys off
 * `isLongTermLiability(type)`, not off the sign, and layering two unrelated
 * decisions into one function is what made the six copies disagree (E7).
 */
export function moneyTone(
  cents: number,
  { context = "asset" }: { context?: MoneyContext } = {},
): MoneyTone {
  if (context === "liability") {
    if (cents > 0) return "positive";
    if (cents === 0) return "neutral";
    return "plain";
  }
  if (cents > 0) return "positive";
  if (cents < 0) return "negative";
  return "neutral";
}

/** `moneyTone` composed with `MONEY_TONE_CLASS`, for the common call site. */
export function moneyToneClass(
  cents: number,
  opts?: { context?: MoneyContext },
): string {
  return MONEY_TONE_CLASS[moneyTone(cents, opts)];
}
