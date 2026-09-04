import { describe, expect, it } from "vitest";
import { resolveRowDisplay, type ExpenseDisplayRow, type IncomeDisplayRow } from "./resolveRowDisplay";

function expenseRow(overrides: Partial<ExpenseDisplayRow> = {}): ExpenseDisplayRow {
  return {
    effectiveCents: 10000,
    spentCents: 5000,
    pendingCents: 0,
    hasAllocation: true,
    ...overrides,
  };
}

function incomeRow(overrides: Partial<IncomeDisplayRow> = {}): IncomeDisplayRow {
  return {
    plannedCents: 10000,
    receivedCents: 10000,
    varianceCents: 0,
    pendingCents: 0,
    hasAllocation: true,
    ...overrides,
  };
}

describe("resolveRowDisplay — TC33a (DS8'): amber over 100%, capped bar, overflow badge", () => {
  it("caps barPct at 100 and returns an overflow badge when spent exceeds effective", () => {
    const result = resolveRowDisplay(
      expenseRow({ effectiveCents: 10000, spentCents: 15000 }),
      "expense",
      "open",
    );
    expect(result.barPct).toBe(100);
    expect(result.barTone).toBe("amber");
    expect(result.badges).toContainEqual({ type: "overflow", amountCents: 5000 });
    expect(result.tone).toBe("negative");
  });

  it("is amber at exactly 80% with no overflow badge", () => {
    const result = resolveRowDisplay(
      expenseRow({ effectiveCents: 10000, spentCents: 8000 }),
      "expense",
      "open",
    );
    expect(result.barPct).toBe(80);
    expect(result.barTone).toBe("amber");
    expect(result.badges).toEqual([]);
  });

  it("is ledger (not amber) below 80%", () => {
    const result = resolveRowDisplay(
      expenseRow({ effectiveCents: 10000, spentCents: 5000 }),
      "expense",
      "open",
    );
    expect(result.barTone).toBe("ledger");
  });

  it("treats any spend with zero allocation as fully over", () => {
    const result = resolveRowDisplay(
      expenseRow({ effectiveCents: 0, spentCents: 100 }),
      "expense",
      "open",
    );
    expect(result.barPct).toBe(100);
    expect(result.tone).toBe("negative");
  });
});

describe("resolveRowDisplay — TC33b (DS12): income capped and green with an over-plan chip", () => {
  it("returns barTone ledger and an over-plan badge when received exceeds planned", () => {
    const result = resolveRowDisplay(
      incomeRow({ plannedCents: 10000, receivedCents: 15000, varianceCents: 5000 }),
      "income",
      "open",
    );
    expect(result.barTone).toBe("ledger");
    expect(result.barPct).toBe(100); // capped, never over 100
    expect(result.badges).toContainEqual({ type: "over-plan", amountCents: 5000 });
    expect(result.tone).toBe("positive");
  });

  it("never returns amber or redbrown for income, even when badly short", () => {
    const result = resolveRowDisplay(
      incomeRow({ plannedCents: 10000, receivedCents: 0, varianceCents: -10000 }),
      "income",
      "open",
    );
    expect(result.barTone).toBe("ledger");
  });
});

describe("resolveRowDisplay — TC33c (DS21): neutral variance while the month is open", () => {
  it("a short income row (uncovered by pending) is neutral, not negative, while open", () => {
    const result = resolveRowDisplay(
      incomeRow({ plannedCents: 10000, receivedCents: 6000, varianceCents: -4000, pendingCents: 0 }),
      "income",
      "open",
    );
    expect(result.tone).toBe("neutral");
  });

  it("is also neutral for a future month", () => {
    const result = resolveRowDisplay(
      incomeRow({ plannedCents: 10000, receivedCents: 0, varianceCents: -10000, pendingCents: 0 }),
      "income",
      "future",
    );
    expect(result.tone).toBe("neutral");
  });
});

describe("resolveRowDisplay — TC33d (DS14): '—' vs '0.00' for unbudgeted vs budgeted-at-zero", () => {
  it("expense: amountPlaceholder is true when no budget_periods row exists", () => {
    const result = resolveRowDisplay(
      expenseRow({ hasAllocation: false, effectiveCents: 0, spentCents: 0 }),
      "expense",
      "open",
    );
    expect(result.amountPlaceholder).toBe(true);
  });

  it("expense: amountPlaceholder is false for a row explicitly allocating $0", () => {
    const result = resolveRowDisplay(
      expenseRow({ hasAllocation: true, effectiveCents: 0, spentCents: 0 }),
      "expense",
      "open",
    );
    expect(result.amountPlaceholder).toBe(false);
  });

  it("income: amountPlaceholder follows the same rule", () => {
    const withRow = resolveRowDisplay(incomeRow({ hasAllocation: true, plannedCents: 0 }), "income", "open");
    const withoutRow = resolveRowDisplay(
      incomeRow({ hasAllocation: false, plannedCents: 0, receivedCents: 0, varianceCents: 0 }),
      "income",
      "open",
    );
    expect(withRow.amountPlaceholder).toBe(false);
    expect(withoutRow.amountPlaceholder).toBe(true);
  });
});

describe("resolveRowDisplay — TC38 (DS33): pending coverage discloses and neutralizes a shortfall", () => {
  it("a shortfall fully covered by pending carries a pending badge and neutral tone, even when closed", () => {
    const result = resolveRowDisplay(
      incomeRow({ plannedCents: 10000, receivedCents: 6000, varianceCents: -4000, pendingCents: 4000 }),
      "income",
      "closed",
    );
    expect(result.tone).toBe("neutral");
    expect(result.badges).toContainEqual({ type: "pending", amountCents: 4000 });
  });

  it("the same row with no pending renders per DS21/DS35 instead — muted once closed", () => {
    const result = resolveRowDisplay(
      incomeRow({ plannedCents: 10000, receivedCents: 6000, varianceCents: -4000, pendingCents: 0 }),
      "income",
      "closed",
    );
    expect(result.tone).toBe("muted");
    expect(result.badges.some((b) => b.type === "pending")).toBe(false);
  });

  it("partial pending coverage does not neutralize the shortfall", () => {
    const result = resolveRowDisplay(
      incomeRow({ plannedCents: 10000, receivedCents: 6000, varianceCents: -4000, pendingCents: 1000 }),
      "income",
      "closed",
    );
    expect(result.tone).toBe("muted");
    expect(result.badges).toContainEqual({ type: "pending", amountCents: 1000 });
  });
});

describe("resolveRowDisplay — TC39 (DS35): closing a month changes income tone but never turns it negative; expense stays negative in both", () => {
  it("a short income row is neutral while open and muted once closed — never negative in either phase", () => {
    const row = incomeRow({ plannedCents: 10000, receivedCents: 6000, varianceCents: -4000 });
    const whileOpen = resolveRowDisplay(row, "income", "open");
    const afterClosed = resolveRowDisplay(row, "income", "closed");
    expect(whileOpen.tone).toBe("neutral");
    expect(afterClosed.tone).toBe("muted");
    expect(whileOpen.tone).not.toBe("negative");
    expect(afterClosed.tone).not.toBe("negative");
  });

  it("an overspent expense row renders negative in both phases", () => {
    const row = expenseRow({ effectiveCents: 10000, spentCents: 15000 });
    const whileOpen = resolveRowDisplay(row, "expense", "open");
    const afterClosed = resolveRowDisplay(row, "expense", "closed");
    expect(whileOpen.tone).toBe("negative");
    expect(afterClosed.tone).toBe("negative");
  });
});

describe("resolveRowDisplay — TC40 (DS40 + E11): 80% vs 120% both amber, only 120% carries the overflow tick; barTone is a token, never redbrown", () => {
  it("80% and 120% both return barTone 'amber', but only 120% carries an overflow badge", () => {
    const at80 = resolveRowDisplay(
      expenseRow({ effectiveCents: 10000, spentCents: 8000 }),
      "expense",
      "open",
    );
    const at120 = resolveRowDisplay(
      expenseRow({ effectiveCents: 10000, spentCents: 12000 }),
      "expense",
      "open",
    );
    expect(at80.barTone).toBe("amber");
    expect(at120.barTone).toBe("amber");
    expect(at80.badges.some((b) => b.type === "overflow")).toBe(false);
    expect(at120.badges.some((b) => b.type === "overflow")).toBe(true);
    // Different output overall, even though barTone alone agrees.
    expect(at80).not.toEqual(at120);
  });

  it("barTone is never 'redbrown' — the design token a raw fill color would use", () => {
    const overspent = resolveRowDisplay(
      expenseRow({ effectiveCents: 10000, spentCents: 99999 }),
      "expense",
      "open",
    );
    expect(overspent.barTone).not.toBe("redbrown");
  });

  it("(F8) identical inputs produce an identical result regardless of which layout calls it", () => {
    const input = expenseRow({ effectiveCents: 10000, spentCents: 9000 });
    const forTableRow = resolveRowDisplay(input, "expense", "open");
    const forMobileCard = resolveRowDisplay(input, "expense", "open");
    expect(forTableRow).toEqual(forMobileCard);
  });
});
