import { describe, expect, it } from "vitest";
import { summarizeBalances, type SummarizableBalance } from "./summarizeBalances";
import { accountClass } from "./accountClass";
import type { AccountType } from "./loadAccountBalances";

/** Built through `accountClass` on purpose, so these cases stay honest about
 *  which real account types land on which side of the split. */
function acct(type: AccountType, balanceCents: number): SummarizableBalance {
  return { class: accountClass(type), balanceCents };
}

describe("summarizeBalances", () => {
  it("returns zeros for an empty ledger", () => {
    expect(summarizeBalances([])).toEqual({
      assetsCents: 0,
      liabilitiesCents: 0,
      netWorthCents: 0,
    });
  });

  it("sums assets only when there are no liabilities — today's behaviour, unchanged", () => {
    const summary = summarizeBalances([acct("checking", 348219), acct("savings", 821004)]);
    expect(summary.assetsCents).toBe(1169223);
    expect(summary.liabilitiesCents).toBe(0);
    expect(summary.netWorthCents).toBe(1169223);
  });

  it("sums liabilities only", () => {
    const summary = summarizeBalances([acct("credit", -214800), acct("loan", -30248011)]);
    expect(summary.assetsCents).toBe(0);
    expect(summary.liabilitiesCents).toBe(-30462811);
    expect(summary.netWorthCents).toBe(-30462811);
  });

  it("keeps the two sides apart in a mixed ledger — the whole point", () => {
    // The failure this prevents: a flat reduce over the same four accounts
    // returns -29293588 and calls it "Total", on every page via the Spine.
    const summary = summarizeBalances([
      acct("checking", 348219),
      acct("savings", 821004),
      acct("credit", -214800),
      acct("loan", -30248011),
    ]);
    expect(summary.assetsCents).toBe(1169223);
    expect(summary.liabilitiesCents).toBe(-30462811);
    expect(summary.netWorthCents).toBe(-29293588);
  });

  it("treats a positive liability balance as the credit balance it is", () => {
    // Overpay a card and the lender owes you. It should raise net worth, not
    // be flipped or clamped on its way through.
    const summary = summarizeBalances([acct("checking", 100000), acct("credit", 5000)]);
    expect(summary.liabilitiesCents).toBe(5000);
    expect(summary.netWorthCents).toBe(105000);
  });

  it("always satisfies netWorth === assets + liabilities", () => {
    const summary = summarizeBalances([
      acct("checking", 1),
      acct("loan", -999999),
      acct("savings", 250000),
      acct("credit", -1),
    ]);
    expect(summary.netWorthCents).toBe(summary.assetsCents + summary.liabilitiesCents);
  });
});
