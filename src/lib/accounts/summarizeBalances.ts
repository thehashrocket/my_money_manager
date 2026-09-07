import type { AccountClass } from "./accountClass";

export type BalanceSummary = {
  /** Sum of every asset account. Always the "can I afford this" figure. */
  assetsCents: number;
  /** Sum of every liability account. Negative (or zero), never positive-as-debt. */
  liabilitiesCents: number;
  /** `assetsCents + liabilitiesCents`. */
  netWorthCents: number;
};

/**
 * Splits a flat balance list into the three figures the dashboard, `/accounts`
 * and the Spine need.
 *
 * This exists because two call sites flat-summed every account
 * (`page.tsx:63` and `spine.tsx:40`, both `reduce((s, a) => s + a.balanceCents, 0)`),
 * which was correct only for as long as every account was an asset. The first
 * mortgage turns that reduce into net worth without renaming it — on the
 * dashboard, and via the Spine on EVERY route in the app:
 *
 *     Checking $2k + Savings $8k + Mortgage -$300k = "Total -$290k"
 *
 * Liabilities are stored negative, so `netWorthCents` is a plain sum rather
 * than a subtraction. Nothing here re-derives a sign; if a liability row
 * arrives positive that is a real credit balance and it correctly increases
 * net worth.
 *
 * D4=A: the Spine headline consumes `assetsCents` and is relabelled "Cash",
 * not net worth — the rail answers "can I afford this," and net worth cannot.
 */
/**
 * Structurally typed rather than taking a full `AccountBalance`: these two
 * fields are all the arithmetic needs, and narrowing the input keeps the
 * function testable without constructing a whole ledger row.
 */
export type SummarizableBalance = { class: AccountClass; balanceCents: number };

export function summarizeBalances(balances: readonly SummarizableBalance[]): BalanceSummary {
  let assetsCents = 0;
  let liabilitiesCents = 0;

  for (const b of balances) {
    if (b.class === "asset") assetsCents += b.balanceCents;
    else liabilitiesCents += b.balanceCents;
  }

  return { assetsCents, liabilitiesCents, netWorthCents: assetsCents + liabilitiesCents };
}
