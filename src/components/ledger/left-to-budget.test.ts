import { describe, expect, it } from "vitest";
import { resolveState, type LeftToBudgetProps } from "./left-to-budget";

function props(overrides: Partial<LeftToBudgetProps> = {}): LeftToBudgetProps {
  return {
    plannedIncomeCents: 100000,
    allocatedCents: 0,
    plannedFundCents: 0,
    leftToBudgetCents: 100000,
    phase: "future",
    railTotalCents: 0,
    ...overrides,
  };
}

describe("resolveState (DS6') — no-income wins outright", () => {
  it("returns no-income on a virgin month (0 - 0 - 0) rather than a false success", () => {
    const result = resolveState(
      props({ plannedIncomeCents: 0, allocatedCents: 0, plannedFundCents: 0, leftToBudgetCents: 0 }),
    );
    expect(result).toEqual({ kind: "no-income" });
  });

  it("returns no-income even when leftToBudgetCents is negative", () => {
    // plannedIncomeCents === 0 must win regardless of what leftToBudgetCents says.
    const result = resolveState(props({ plannedIncomeCents: 0, leftToBudgetCents: -500 }));
    expect(result).toEqual({ kind: "no-income" });
  });
});

describe("resolveState — over-budgeted", () => {
  it("returns over when leftToBudgetCents is negative", () => {
    const result = resolveState(props({ leftToBudgetCents: -1 }));
    expect(result).toEqual({ kind: "over" });
  });
});

describe("resolveState — success", () => {
  it("returns success when leftToBudgetCents is exactly 0 and income is planned", () => {
    const result = resolveState(
      props({ plannedIncomeCents: 100000, allocatedCents: 100000, leftToBudgetCents: 0 }),
    );
    expect(result).toEqual({ kind: "success" });
  });
});

describe("resolveState — progress vs unassigned by phase", () => {
  it("returns progress with the assigned percentage in a future month", () => {
    const result = resolveState(
      props({
        plannedIncomeCents: 100000,
        allocatedCents: 25000,
        plannedFundCents: 0,
        leftToBudgetCents: 75000,
        phase: "future",
      }),
    );
    expect(result).toEqual({ kind: "progress", assignedPct: 25 });
  });

  it("returns unassigned with the assigned percentage in the open (current) month", () => {
    const result = resolveState(
      props({
        plannedIncomeCents: 100000,
        allocatedCents: 25000,
        plannedFundCents: 0,
        leftToBudgetCents: 75000,
        phase: "open",
      }),
    );
    expect(result).toEqual({ kind: "unassigned", assignedPct: 25 });
  });

  it("folds plannedFundCents into the assigned percentage alongside allocatedCents", () => {
    const result = resolveState(
      props({
        plannedIncomeCents: 100000,
        allocatedCents: 20000,
        plannedFundCents: 10000,
        leftToBudgetCents: 70000,
        phase: "closed",
      }),
    );
    expect(result).toEqual({ kind: "unassigned", assignedPct: 30 });
  });

  it("clamps assignedPct to 100 when allocated + fund exceeds income without going negative", () => {
    // leftToBudgetCents itself decides over/success/progress first; this
    // scenario only occurs with inconsistent inputs, but the clamp must
    // still hold rather than rendering an overflowing progress bar.
    const result = resolveState(
      props({
        plannedIncomeCents: 100000,
        allocatedCents: 150000,
        plannedFundCents: 0,
        leftToBudgetCents: 5000,
        phase: "future",
      }),
    );
    expect(result).toEqual({ kind: "progress", assignedPct: 100 });
  });

  it("clamps assignedPct to 0 when allocated + fund is negative", () => {
    const result = resolveState(
      props({
        plannedIncomeCents: 100000,
        allocatedCents: -5000,
        plannedFundCents: 0,
        leftToBudgetCents: 5000,
        phase: "future",
      }),
    );
    expect(result).toEqual({ kind: "progress", assignedPct: 0 });
  });
});
