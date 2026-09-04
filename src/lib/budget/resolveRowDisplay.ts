import type { MonthPhase } from "./monthOfIso";

/**
 * C1: every display DECISION for a budget row — tone, bar fill, whether an
 * amount shows a placeholder, which badges appear — lives here as one pure,
 * tested function. CLAUDE.md scopes tests to "categorization logic only";
 * a rule written in JSX is a rule this repo cannot test. Before this
 * function the same tone rule was written FIVE times across TWO color
 * systems (envelope-card.tsx's `resolveState`/`FILL_COLORS`, page.tsx's
 * `RemainingCell` text tone, and page.tsx's own desktop-table bar, which
 * used a third, raw-Tailwind palette) — this is one function, six dumb
 * renderers (3 kinds × 2 layouts).
 *
 * `barTone` is a design-token NAME (`"ledger" | "amber" | "redbrown"`),
 * never a color a renderer picks itself (E11) — both the table row and the
 * mobile card render `var(--accent-${barTone})` directly, so a tone rule
 * cannot drift between them (F8) the way it did before this existed.
 */

export type RowTone = "positive" | "negative" | "neutral" | "muted";
export type BarTone = "ledger" | "amber" | "redbrown";

export type PendingBadge = { type: "pending"; amountCents: number };
export type OverPlanBadge = { type: "over-plan"; amountCents: number };
export type OverflowBadge = { type: "overflow"; amountCents: number };

export type RowBadge = PendingBadge | OverPlanBadge | OverflowBadge;

/**
 * Split by row kind rather than one flat shape: income never uses `negative`
 * tone, a non-`"ledger"` bar, or an `overflow` badge (those are expense-only
 * concepts — DS12/DS35), and expense never produces an `over-plan` badge or
 * a `"muted"` tone. A shared flat type let those illegal combinations
 * type-check even though no code path here produces them today; this makes
 * them unrepresentable instead of merely untested.
 */
type BaseRowDisplay = {
  /** 0-100, always capped — the bar never renders past full. */
  barPct: number;
  /** DS14: true means render "—", not `formatCents(0)` — `formatCents`
   * cannot express "no budget_periods row" vs "a row allocating $0". */
  amountPlaceholder: boolean;
  /** T28/A8/DS23: an EXPENSE-kind category with net-positive money flowing
   * INTO it this month — the Layer 2 partial-failure shape F1 describes
   * (a category that should be `kind='income'` but isn't). Always `false`
   * for income rows, which never need to be told they look like themselves.
   * Non-dismissible by design (DS23) — a per-render fact, not a warning to
   * acknowledge and forget. */
  looksLikeIncome: boolean;
};

export type ExpenseRowDisplay = BaseRowDisplay & {
  kind: "expense";
  tone: Extract<RowTone, "positive" | "negative" | "neutral">;
  barTone: Extract<BarTone, "ledger" | "amber">;
  badges: (PendingBadge | OverflowBadge)[];
};

export type IncomeRowDisplay = BaseRowDisplay & {
  kind: "income";
  tone: Extract<RowTone, "positive" | "neutral" | "muted">;
  barTone: "ledger";
  badges: (PendingBadge | OverPlanBadge)[];
};

export type RowDisplay = ExpenseRowDisplay | IncomeRowDisplay;

export type ExpenseDisplayRow = {
  effectiveCents: number;
  spentCents: number;
  pendingCents: number;
  /** Whether a `budget_periods` row exists for this leaf this month. */
  hasAllocation: boolean;
};

export type IncomeDisplayRow = {
  plannedCents: number;
  receivedCents: number;
  varianceCents: number;
  pendingCents: number;
  hasAllocation: boolean;
};

export function resolveRowDisplay(
  row: ExpenseDisplayRow,
  kind: "expense",
  phase: MonthPhase,
): ExpenseRowDisplay;
export function resolveRowDisplay(
  row: IncomeDisplayRow,
  kind: "income",
  phase: MonthPhase,
): IncomeRowDisplay;
export function resolveRowDisplay(
  row: ExpenseDisplayRow | IncomeDisplayRow,
  kind: "expense" | "income",
  phase: MonthPhase,
): RowDisplay {
  if (kind === "expense") {
    return resolveExpenseRow(row as ExpenseDisplayRow);
  }
  return resolveIncomeRow(row as IncomeDisplayRow, phase);
}

/**
 * DS8' + DS40: amber fills proportionally up to 100% for both "on track"
 * (<80%) and "warn" (>=80%, still amber — same fill color as warn, just a
 * later point on the bar); past 100% the bar itself stays amber and CAPS at
 * 100% rather than turning redbrown — redbrown is reserved for a 2px
 * overflow tick (returned as a badge, not baked into `barTone`) so the
 * bar's only red signal per row is that tick plus the Remaining figure. An
 * envelope at 80% and one at 120% both return `barTone: "amber"`; only the
 * 120% one carries an `overflow` badge — that is the distinction DS8's
 * "one red signal per row" rule must not erase.
 *
 * DS14: `amountPlaceholder` is true exactly when no `budget_periods` row
 * exists — distinct from a row that allocates exactly $0.
 */
function resolveExpenseRow(row: ExpenseDisplayRow): ExpenseRowDisplay {
  const { effectiveCents, spentCents, pendingCents, hasAllocation } = row;

  const raw = effectiveCents > 0 ? (spentCents / effectiveCents) * 100 : spentCents > 0 ? 100 : 0;
  const barPct = Math.min(100, Math.max(0, raw));
  // Spending against a zero-or-absent allocation is the worst overspend
  // state there is, but `raw` clamps to exactly 100 in that case (division
  // by a non-positive `effectiveCents` is undefined, so it's special-cased
  // above) — `raw > 100` alone misses it entirely and the row loses its
  // overflow tick, the one signal DS8 reserves for "over" specifically.
  const isOver = raw > 100 || (effectiveCents <= 0 && spentCents > 0);
  const isWarn = raw >= 80;
  const barTone: ExpenseRowDisplay["barTone"] = isOver || isWarn ? "amber" : "ledger";

  const remainingCents = effectiveCents - spentCents;
  const tone: ExpenseRowDisplay["tone"] =
    remainingCents < 0 ? "negative" : remainingCents === 0 ? "neutral" : "positive";

  const badges: ExpenseRowDisplay["badges"] = [];
  if (pendingCents > 0) badges.push({ type: "pending", amountCents: pendingCents });
  if (isOver) badges.push({ type: "overflow", amountCents: spentCents - effectiveCents });

  // T28: negative "spent" is nonsensical for a true expense category — it
  // means net money flowed IN this month (`spentCents = 0 - SUM(amount_cents)`,
  // so a positive SUM, i.e. deposits, produces a negative `spentCents`).
  // Exactly zero activity is not flagged; there is nothing to point at yet.
  const looksLikeIncome = spentCents < 0;

  return { kind: "expense", tone, barPct, barTone, amountPlaceholder: !hasAllocation, badges, looksLikeIncome };
}

/**
 * DS12: income's bar is always ledger-green (income does not "overspend"),
 * capped at 100%, with an `over-plan` badge (DS12's "+$X over plan" chip)
 * when received exceeds planned.
 *
 * DS21 + DS35 + DS33 together decide `tone`:
 * - DS33: when this category's pending money covers the shortfall, tone is
 *   `neutral` regardless of month phase — TS2 deliberately excludes pending
 *   from `received`, so a pending paycheck must not read as a missing one.
 * - DS21: while the month is still open (or hasn't started), a shortfall
 *   not covered by pending is `neutral`, not a verdict — you can still act.
 * - DS35: once the month closes, a shortfall renders `muted` ("record, not
 *   verdict"), NOT `negative` — DS21 originally sent a closed month's short
 *   income rows to `--money-neg`, which retroactively paints every closed
 *   month's income red on the 1st of the next month, forever. `--money-neg`
 *   stays reserved for expense overspend, in any month; income never uses
 *   `negative` tone at all, in either phase.
 * - Met or exceeded plan is always `positive`, in any phase — closing a
 *   month does not need to mute good news the same way it mutes bad news.
 *
 * DS14: `amountPlaceholder` mirrors the expense rule — true only when no
 * `budget_periods` row exists for this income category this month.
 */
function resolveIncomeRow(row: IncomeDisplayRow, phase: MonthPhase): IncomeRowDisplay {
  const { plannedCents, receivedCents, varianceCents, pendingCents, hasAllocation } = row;

  const raw = plannedCents > 0 ? (receivedCents / plannedCents) * 100 : receivedCents > 0 ? 100 : 0;
  const barPct = Math.min(100, Math.max(0, raw));

  const shortfallCents = -varianceCents; // positive when short
  const coveredByPending = shortfallCents > 0 && pendingCents >= shortfallCents;

  let tone: IncomeRowDisplay["tone"];
  if (varianceCents >= 0) {
    tone = "positive";
  } else if (coveredByPending) {
    tone = "neutral";
  } else if (phase === "closed") {
    tone = "muted";
  } else {
    tone = "neutral";
  }

  const badges: IncomeRowDisplay["badges"] = [];
  if (pendingCents > 0) badges.push({ type: "pending", amountCents: pendingCents });
  if (varianceCents > 0) badges.push({ type: "over-plan", amountCents: varianceCents });

  return {
    kind: "income",
    tone,
    barPct,
    barTone: "ledger",
    amountPlaceholder: !hasAllocation,
    badges,
    looksLikeIncome: false,
  };
}
