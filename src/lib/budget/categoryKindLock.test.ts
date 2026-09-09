import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  assignableKinds,
  isCategoryUsed,
  kindLockReason,
  loadCategoryKindUsage,
  NO_USAGE,
} from "@/lib/budget/categoryKindLock";

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

/* The drizzle half. `assignableKinds` above is pure and `loadMonthView` pins
   the wiring end-to-end, but the two grouped queries and the merge between
   them have branches the read model cannot reach on its own — notably a
   category holding rows in BOTH tables, where the period pass must not
   clobber the transaction pass's `negativeTxnCount` and silently retract X1. */
describe("loadCategoryKindUsage", () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = createTestDb();
  });

  afterEach(() => {
    handle.close();
  });

  let seq = 0;
  function seedCategory(kind: "income" | "expense" | "fund" = "expense") {
    seq += 1;
    const [cat] = handle.db
      .insert(schema.categories)
      .values({ name: `Cat-${seq}`, kind })
      .returning()
      .all();
    return cat;
  }

  function seedTxn(categoryId: number, amountCents: number) {
    seq += 1;
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: `Checking-${seq}`,
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    const [batch] = handle.db
      .insert(schema.importBatches)
      .values({ source: "csv", label: `seed-${seq}.csv` })
      .returning()
      .all();
    handle.db
      .insert(schema.transactions)
      .values({
        accountId: account.id,
        date: "2026-04-10",
        rawDescription: "TEST",
        rawMemo: "",
        normalizedMerchant: "TEST",
        amountCents,
        categoryId,
        importSource: "csv",
        importBatchId: batch.id,
        importRowHash: `hash-${seq}`,
      })
      .run();
  }

  it("returns an empty map for an empty id list, without issuing a query", () => {
    // `inArray(col, [])` is not a safe no-op in drizzle/SQLite, which is why
    // the early return exists rather than being left to the WHERE clause.
    expect(loadCategoryKindUsage(handle.db, [])).toEqual(new Map());
  });

  it("omits a category with rows in neither table, which callers read as NO_USAGE", () => {
    const cat = seedCategory();
    const usage = loadCategoryKindUsage(handle.db, [cat.id]);

    expect(usage.has(cat.id)).toBe(false);
    expect(assignableKinds("expense", usage.get(cat.id) ?? NO_USAGE).slice().sort()).toEqual([
      "expense",
      "fund",
      "income",
    ]);
  });

  /* The merge branch. A category with a transaction AND a budget_periods row
     goes through `{ ...existing, periodCount }`; spreading the wrong way round
     — or rebuilding from NO_USAGE — zeroes `negativeTxnCount`, which reads as
     "all rows positive" and hands X1 back to a category full of spending. */
  it("keeps negativeTxnCount when the same category also has a budget_periods row", () => {
    const cat = seedCategory();
    seedTxn(cat.id, -2500);
    seedTxn(cat.id, 1000);
    handle.db
      .insert(schema.budgetPeriods)
      .values({ categoryId: cat.id, year: 2026, month: 4, allocatedCents: 5000 })
      .run();

    expect(loadCategoryKindUsage(handle.db, [cat.id]).get(cat.id)).toEqual({
      txnCount: 2,
      negativeTxnCount: 1,
      periodCount: 1,
    });
  });

  it("counts each requested category separately and ignores ones not asked for", () => {
    const asked = seedCategory();
    const other = seedCategory();
    seedTxn(asked.id, 5000);
    seedTxn(other.id, -5000);

    const usage = loadCategoryKindUsage(handle.db, [asked.id]);
    expect(usage.get(asked.id)).toEqual({ txnCount: 1, negativeTxnCount: 0, periodCount: 0 });
    expect(usage.has(other.id)).toBe(false);
  });
});

/* The menu renders this when `assignableKinds` has collapsed to one entry.
   It is the only explanation the app still has for a kind lock: the `⋯` menu
   on /budget is the sole surface that reaches `setCategoryKindAction` for an
   arbitrary kind (`_reclassify-income.tsx` reaches it for X1 alone), so a
   locked row that says only "locked" leaves the user unable to tell a refusal
   from a missing feature. */
describe("kindLockReason", () => {
  it("is null for a category rule 8 has not locked", () => {
    expect(kindLockReason(NO_USAGE)).toBeNull();
  });

  it("names transactions when the category has any, and pluralises", () => {
    expect(kindLockReason({ txnCount: 1, negativeTxnCount: 1, periodCount: 0 })).toBe(
      "1 transaction filed here",
    );
    expect(kindLockReason({ txnCount: 12, negativeTxnCount: 12, periodCount: 0 })).toBe(
      "12 transactions filed here",
    );
  });

  /* The case a user reaches by accident: one keystroke in the FUNDS band —
     `$0` included — locks the kind with no transaction anywhere. Naming the
     planned month is the whole point; "0 transactions filed here" would be
     true and useless. */
  it("names the planned month when a budget_periods row is the only usage", () => {
    expect(kindLockReason({ txnCount: 0, negativeTxnCount: 0, periodCount: 1 })).toBe(
      "a month is already budgeted here",
    );
  });

  it("prefers the transaction count when the category has both", () => {
    expect(kindLockReason({ txnCount: 3, negativeTxnCount: 3, periodCount: 2 })).toBe(
      "3 transactions filed here",
    );
  });

  /* The invariant the menu depends on, and it is one-directional.

     Whenever `assignableKinds` collapses to a single entry the menu renders
     the label INSTEAD of items, so a null reason there would draw a bare
     "locked" with no cause — exactly the failure the reason exists to prevent.
     That direction must hold for every input.

     The converse must NOT be asserted, and X1 is why: an expense category with
     only positive rows is "used" (so it has a reason) yet still offers
     expense→income, so `assignableKinds` has two entries and the label is never
     drawn. A non-null reason on a row that is not collapsed is unread, not
     wrong. Asserting equivalence here failed on exactly that case. */
  it("is non-null whenever assignableKinds has collapsed to one entry", () => {
    const cases = [
      NO_USAGE,
      { txnCount: 1, negativeTxnCount: 0, periodCount: 0 },
      { txnCount: 1, negativeTxnCount: 1, periodCount: 0 },
      { txnCount: 0, negativeTxnCount: 0, periodCount: 1 },
      { txnCount: 4, negativeTxnCount: 2, periodCount: 3 },
    ];
    for (const usage of cases) {
      for (const kind of ["expense", "income", "fund"] as const) {
        if (assignableKinds(kind, usage).length !== 1) continue;
        expect(kindLockReason(usage)).not.toBeNull();
      }
    }
  });

  /* The X1 row the case above skips, pinned explicitly so the skip cannot
     quietly grow to cover a case that should have been checked. */
  it("leaves the X1 row uncollapsed, so its reason is never rendered", () => {
    const x1 = { txnCount: 1, negativeTxnCount: 0, periodCount: 0 };
    expect(assignableKinds("expense", x1).sort()).toEqual(["expense", "income"]);
    expect(kindLockReason(x1)).toBe("1 transaction filed here");
  });
});
