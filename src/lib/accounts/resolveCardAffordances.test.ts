import { describe, expect, it } from "vitest";
import type { AccountType } from "./loadAccountBalances";
import {
  isAppCreatedCardPaymentPair,
  isSyntheticCardPaymentMirror,
  pairingWarnsOnCategorized,
  resolveCardAffordances,
} from "./resolveCardAffordances";

const FEED = "ACT-d326a3ba-0000";
const TODAY = "2026-09-14";

const UNLINKED_CARD = {
  type: "credit" as AccountType,
  startingBalanceDate: "2026-08-01",
  simplefinAccountId: null,
};
const IMPORTING_CARD = {
  type: "credit" as AccountType,
  startingBalanceDate: "2026-08-01",
  simplefinAccountId: FEED,
};
const MORTGAGE = {
  type: "loan" as AccountType,
  startingBalanceDate: "2026-08-01",
  simplefinAccountId: FEED,
};

describe("resolveCardAffordances", () => {
  it("offers all four affordances for an unlinked card anchored in the past", () => {
    expect(resolveCardAffordances(UNLINKED_CARD, "reconcile", TODAY)).toEqual({
      canAddCharge: true,
      canEditTerms: true,
      showReconcile: true,
      allowsPositiveBalance: true,
    });
  });

  it("withholds canAddCharge for a card anchored TODAY — D12's legal-date window is empty", () => {
    expect(
      resolveCardAffordances({ ...UNLINKED_CARD, startingBalanceDate: TODAY }, "reconcile", TODAY),
    ).toMatchObject({ canAddCharge: false });
  });

  it("withholds canAddCharge for a card that imports its own transactions (D8.3b)", () => {
    expect(resolveCardAffordances(IMPORTING_CARD, "reconcile", TODAY)).toEqual({
      canAddCharge: false,
      canEditTerms: true,
      showReconcile: true,
      allowsPositiveBalance: true,
    });
  });

  it("withholds canAddCharge, canEditTerms and allowsPositiveBalance for a long-term liability (the mortgage) — rule 9's sign guard", () => {
    expect(resolveCardAffordances(MORTGAGE, "reconcile", TODAY)).toEqual({
      canAddCharge: false,
      canEditTerms: false,
      showReconcile: true,
      allowsPositiveBalance: false,
    });
  });

  it("relays showReconcile from the balance action rather than re-deriving it (DS55)", () => {
    expect(resolveCardAffordances(UNLINKED_CARD, "refresh", TODAY)).toMatchObject({
      showReconcile: false,
    });
  });
});

describe("pairingWarnsOnCategorized (D4.1)", () => {
  it("warns when the source leg already carries a category", () => {
    expect(pairingWarnsOnCategorized({ categoryId: 7 })).toBe(true);
  });

  it("does not warn on an uncategorized source leg", () => {
    expect(pairingWarnsOnCategorized({ categoryId: null })).toBe(false);
  });
});

describe("isSyntheticCardPaymentMirror / isAppCreatedCardPaymentPair (D5.2)", () => {
  const mirror = { importSource: "manual" as const, categoryId: null };
  const realBankRow = { importSource: "simplefin" as const, categoryId: 3 };
  const manualCharge = { importSource: "manual" as const, categoryId: 3 };

  it("identifies the synthetic mirror markAsCardPayment writes", () => {
    expect(isSyntheticCardPaymentMirror(mirror)).toBe(true);
  });

  it("does not mistake a hand-typed, categorized card charge for a mirror", () => {
    expect(isSyntheticCardPaymentMirror(manualCharge)).toBe(false);
  });

  it("does not mistake a real bank row for a mirror", () => {
    expect(isSyntheticCardPaymentMirror(realBankRow)).toBe(false);
  });

  it("a pair is app-created when EITHER leg is the synthetic mirror", () => {
    expect(isAppCreatedCardPaymentPair(realBankRow, mirror)).toBe(true);
    expect(isAppCreatedCardPaymentPair(mirror, realBankRow)).toBe(true);
  });

  it("a pair of two real bank rows (T9's manual link) is NOT app-created", () => {
    expect(isAppCreatedCardPaymentPair(realBankRow, realBankRow)).toBe(false);
  });
});
