import { describe, expect, it } from "vitest";
import { assignableKinds, isCategoryUsed, NO_USAGE } from "@/lib/budget/categoryKindLock";

/**
 * Rule 8's "is this category used?" and its X1 exception, as a pure function.
 *
 * It lived inline in `setCategoryKind` until the round-5 review: the FUNDS
 * band becoming editable gave a fund a write path to a `budget_periods` row,
 * after which `CategoryMenu` kept offering "Set kind: expense" on a fund that
 * had one — an item the server always refused (DS32). The menu needs the same
 * verdict the writer enforces, so there is one spelling and these tests pin
 * it for both.
 */
describe("assignableKinds", () => {
  it("offers every kind on a category with no transactions and no budget_periods row", () => {
    expect(assignableKinds("expense", NO_USAGE).sort()).toEqual(["expense", "fund", "income"]);
  });

  it("locks a category to its current kind once it has a transaction", () => {
    expect(assignableKinds("fund", { txnCount: 1, negativeTxnCount: 1, periodCount: 0 })).toEqual(["fund"]);
  });

  /* The case this whole change exists for. Before the FUNDS band was editable
     a fund could not acquire a `budget_periods` row from anywhere, so `isUsed`
     was effectively transactions-only for `kind='fund'`. Now one keystroke in
     the band writes one. */
  it("locks a FUND that has only a budget_periods row — including a $0 one", () => {
    expect(assignableKinds("fund", { txnCount: 0, negativeTxnCount: 0, periodCount: 1 })).toEqual(["fund"]);
  });

  it("locks an expense that has only a budget_periods row, with no X1 escape", () => {
    // X1's guard is `txnCount > 0 && negativeCount === 0` — evidence FROM ROWS
    // that the category was always income. A planned row is not that evidence.
    expect(assignableKinds("expense", { txnCount: 0, negativeTxnCount: 0, periodCount: 1 })).toEqual(["expense"]);
  });

  it("(X1) still allows expense -> income on a used, all-positive category", () => {
    expect(assignableKinds("expense", { txnCount: 4, negativeTxnCount: 0, periodCount: 2 }).sort()).toEqual([
      "expense",
      "income",
    ]);
  });

  it("(X1) refuses expense -> income the moment one negative row exists", () => {
    expect(assignableKinds("expense", { txnCount: 4, negativeTxnCount: 1, periodCount: 0 })).toEqual(["expense"]);
  });

  /* X1 is expense->income ONLY. Generalising it to a fund is the fix direction
     this review considered and rejected: a fund locked by a planned row has no
     equivalent evidence to offer, and that row is genuine usage in three
     subsystems at once (leftToBudget, rollover eligibility, loadGoals). */
  it("(X1) does not leak to a used, all-positive FUND", () => {
    expect(assignableKinds("fund", { txnCount: 4, negativeTxnCount: 0, periodCount: 0 })).toEqual(["fund"]);
  });

  it("(X1) does not leak to income -> expense on a used, all-positive category", () => {
    expect(assignableKinds("income", { txnCount: 4, negativeTxnCount: 0, periodCount: 0 })).toEqual(["income"]);
  });

  it("always includes the current kind, which setCategoryKind treats as a no-op success", () => {
    for (const kind of ["expense", "income", "fund"] as const) {
      expect(assignableKinds(kind, { txnCount: 9, negativeTxnCount: 9, periodCount: 9 })).toContain(kind);
    }
  });
});

describe("isCategoryUsed", () => {
  it("is false only when both counts are zero", () => {
    expect(isCategoryUsed(NO_USAGE)).toBe(false);
    expect(isCategoryUsed({ txnCount: 1, negativeTxnCount: 0, periodCount: 0 })).toBe(true);
    expect(isCategoryUsed({ txnCount: 0, negativeTxnCount: 0, periodCount: 1 })).toBe(true);
  });
});
