import { describe, expect, it } from "vitest";
import type { AccountType } from "./loadAccountBalances";
import { importsTransactions } from "./importsTransactions";
import { accountClass } from "./accountClass";
import { isLongTermLiability } from "./isLongTermLiability";

const ALL_TYPES = ["checking", "savings", "credit", "loan"] as const satisfies readonly AccountType[];

const FEED = "ACT-citi";

describe("importsTransactions", () => {
  it("stages a linked card — the whole point of the change", () => {
    expect(importsTransactions({ type: "credit", simplefinAccountId: FEED })).toBe(true);
  });

  it("does NOT stage an unlinked card", () => {
    // Not a rounding-off of the rule — this row is what keeps the synthetic
    // payment mirror working on a card the feed can never reach (AMEX, BofA),
    // while removing it from the one it can (D8.3).
    expect(importsTransactions({ type: "credit", simplefinAccountId: null })).toBe(false);
  });

  it("never stages a loan, linked or not (D1)", () => {
    expect(importsTransactions({ type: "loan", simplefinAccountId: FEED })).toBe(false);
    expect(importsTransactions({ type: "loan", simplefinAccountId: null })).toBe(false);
  });

  it("stages a linked asset and not an unlinked one — this is about the FEED", () => {
    // An unlinked checking account still gets rows, from CSV. This predicate
    // is deliberately not asking that question, and the name says so.
    expect(importsTransactions({ type: "checking", simplefinAccountId: FEED })).toBe(true);
    expect(importsTransactions({ type: "savings", simplefinAccountId: FEED })).toBe(true);
    expect(importsTransactions({ type: "checking", simplefinAccountId: null })).toBe(false);
    expect(importsTransactions({ type: "savings", simplefinAccountId: null })).toBe(false);
  });

  it("is TOTAL over both inputs — every type × link state yields a boolean", () => {
    for (const type of ALL_TYPES) {
      for (const simplefinAccountId of [FEED, null]) {
        expect(typeof importsTransactions({ type, simplefinAccountId })).toBe("boolean");
      }
    }
  });

  it("throws rather than silently defaulting on an unrecognized type", () => {
    expect(() =>
      importsTransactions({
        type: "line_of_credit" as unknown as AccountType,
        simplefinAccountId: FEED,
      }),
    ).toThrow(/unrecognized accounts.type/);
  });

  it("pins the ONE case where it disagrees with the predicate it replaces", () => {
    // Before this existed, `partitionLinkedAccounts` asked
    // `accountClass(type) === "asset"`. Every linked account it saw that is
    // now staged and was not is a CARD, and nothing else moved — that is the
    // entire behavioural delta of the partition change, asserted rather than
    // described.
    for (const type of ALL_TYPES) {
      const wasStaged = accountClass(type) === "asset";
      const isStaged = importsTransactions({ type, simplefinAccountId: FEED });
      if (wasStaged !== isStaged) {
        expect(type).toBe("credit");
        expect(isStaged).toBe(true);
      }
    }
  });

  it("agrees with `!isLongTermLiability` for every LINKED account, and that is not a coincidence to rely on", () => {
    // True today because `{credit, loan}` has exactly two members — the same
    // accident `isCreditCard`'s docstring warns about. Pinned so a third
    // liability type has to break this test and make a deliberate choice
    // rather than inherit one.
    for (const type of ALL_TYPES) {
      expect(importsTransactions({ type, simplefinAccountId: FEED })).toBe(
        !isLongTermLiability(type),
      );
    }
  });
});
