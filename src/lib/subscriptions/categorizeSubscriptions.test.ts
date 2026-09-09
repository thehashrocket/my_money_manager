import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  fileAllSubscriptions,
  fileSubscription,
} from "./categorizeSubscriptions";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedAccount() {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: `Checking-${seq}`,
      type: "checking",
      startingBalanceCents: 0,
      startingBalanceDate: "2026-01-01",
    })
    .returning()
    .all();
  return row;
}

function seedBatch() {
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", label: "seed.csv" })
    .returning()
    .all();
  return row;
}

function seedCategory(name: string) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: `${name}-${seq}`,
      parentId: null,
      isSavingsGoal: false,
      kind: "expense",
      carryoverPolicy: "none",
      archivedAt: null,
    })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  merchant: string;
  date: string;
  categoryId?: number | null;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "PURCHASE",
      rawMemo: opts.merchant,
      normalizedMerchant: opts.merchant,
      amountCents: -1599,
      categoryId: opts.categoryId ?? null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: null,
      isPending: false,
    })
    .returning()
    .all();
  return row;
}

function exactRule(matchValue: string) {
  return handle.db
    .select()
    .from(schema.categoryRules)
    .where(
      and(
        eq(schema.categoryRules.matchType, "exact"),
        eq(schema.categoryRules.matchValue, matchValue),
      ),
    )
    .get();
}

describe("fileSubscription", () => {
  it("files the rows and trains the rule for an ordinary key", () => {
    const a = seedAccount();
    const b = seedBatch();
    const subs = seedCategory("Subscriptions");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SOMEAPP",
      date: "2026-02-01",
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SOMEAPP",
      date: "2026-03-01",
    });

    const outcome = fileSubscription(handle.db, "SOMEAPP", subs.id);
    expect(outcome.filedCount).toBe(2);
    expect(outcome.refusal).toBeNull();
    expect(exactRule("SOMEAPP")?.categoryId).toBe(subs.id);
  });

  it("REPORTS the refusal instead of swallowing it", () => {
    /* This was the whole gap: the action discarded `bulkCategorize`'s result, so
       a merchant whose rule could not be trained looked identical to one whose
       rule was. */
    const a = seedAccount();
    const b = seedBatch();
    const entertainment = seedCategory("Entertainment");
    const subs = seedCategory("Subscriptions");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SOMEAPP",
      date: "2026-02-01",
      categoryId: entertainment.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SOMEAPP",
      date: "2026-03-01",
    });

    const outcome = fileSubscription(handle.db, "SOMEAPP", subs.id);
    expect(outcome.filedCount).toBe(1);
    expect(outcome.refusal).not.toBeNull();
    // Names the reason in a form a person can act on.
    expect(outcome.refusal).toContain("SOMEAPP");
  });

  it("never REMOVES an existing rule, however much the pick contradicts it", () => {
    /* The unrecoverable case. `loadSubscriptions` does not filter on
       `category_id`, so a merchant already filed under a working rule is still
       "active" and one "Categorize all" click reached it. This page has no undo
       and no rules surface, so a removal here was permanent. */
    const a = seedAccount();
    const b = seedBatch();
    const entertainment = seedCategory("Entertainment");
    const subs = seedCategory("Subscriptions");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: entertainment.id,
        matchType: "exact",
        matchValue: "SOMEAPP",
        priority: 50,
        source: "manual",
      })
      .run();
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SOMEAPP",
      date: "2026-02-01",
      categoryId: entertainment.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SOMEAPP",
      date: "2026-03-01",
    });

    const outcome = fileSubscription(handle.db, "SOMEAPP", subs.id);
    expect(outcome.refusal).not.toBeNull();
    expect(exactRule("SOMEAPP")?.categoryId).toBe(entertainment.id);
  });
});

describe("fileSubscription — retargeting an existing rule", () => {
  it("REPORTS an upsert that repoints a rule the user trained", () => {
    /* "This page cannot remove a rule" was true and not enough: a trainable
       verdict still upserts, and the upsert retargets. Reachable with no crafted
       input — undoing a batch's import-time categorization resets its rows to
       NULL and leaves the rule standing (rule 6), so the key reads as UNFILED,
       the verdict is trainable, and one click repoints a hand-trained rule. There
       is no undo on this page, so the notice is the whole mitigation. */
    const a = seedAccount();
    const b = seedBatch();
    const books = seedCategory("Books");
    const subs = seedCategory("Subscriptions");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: books.id,
        matchType: "exact",
        matchValue: "AUDIBLE",
        priority: 50,
        source: "manual",
      })
      .run();
    // Rows uncategorized, exactly as an import-categorization undo leaves them.
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AUDIBLE",
      date: "2026-02-01",
    });

    const outcome = fileSubscription(handle.db, "AUDIBLE", subs.id);
    expect(outcome.refusal).toBeNull();
    expect(outcome.retargetedRule).not.toBeNull();
    expect(outcome.retargetedRule).toContain("AUDIBLE");
    expect(outcome.retargetedRule).toContain(books.name);
    expect(outcome.retargetedRule).toContain(subs.name);
    // And the rule really did move, which is what the notice is about.
    expect(exactRule("AUDIBLE")?.categoryId).toBe(subs.id);
  });

  it("reports nothing to retarget when the merchant had no rule", () => {
    const a = seedAccount();
    const b = seedBatch();
    const subs = seedCategory("Subscriptions");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "NEWAPP",
      date: "2026-02-01",
    });

    expect(fileSubscription(handle.db, "NEWAPP", subs.id).retargetedRule).toBeNull();
  });
});

describe("fileAllSubscriptions", () => {
  it("files every active merchant and reports the totals", () => {
    const a = seedAccount();
    const b = seedBatch();
    const subs = seedCategory("Subscriptions");

    // Three charges a month apart is what `detectSubscriptions` needs.
    for (const merchant of ["GOODAPP", "OTHERAPP"]) {
      for (const date of ["2026-01-15", "2026-02-15", "2026-03-15"]) {
        seedTxn({ accountId: a.id, batchId: b.id, merchant, date });
      }
    }

    const outcome = fileAllSubscriptions(handle.db, subs.id);
    expect(outcome.failures).toEqual([]);
    expect(outcome.merchantsFiled).toBe(2);
    expect(outcome.filedCount).toBe(6);
    expect(exactRule("GOODAPP")?.categoryId).toBe(subs.id);
    expect(exactRule("OTHERAPP")?.categoryId).toBe(subs.id);
  });

  it("collects a refusal per merchant rather than one summary flag", () => {
    // The toast names the merchants, so the outcome has to carry them
    // individually — a count alone is the same silence this replaced.
    const a = seedAccount();
    const b = seedBatch();
    const entertainment = seedCategory("Entertainment");
    const subs = seedCategory("Subscriptions");
    for (const date of ["2026-01-15", "2026-02-15", "2026-03-15"]) {
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "SPLITAPP", date });
    }
    // One already-filed row elsewhere is what makes the key multi-category.
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SPLITAPP",
      date: "2025-12-15",
      categoryId: entertainment.id,
    });
    for (const date of ["2026-01-20", "2026-02-20", "2026-03-20"]) {
      seedTxn({ accountId: a.id, batchId: b.id, merchant: "CLEANAPP", date });
    }

    const outcome = fileAllSubscriptions(handle.db, subs.id);
    expect(outcome.refusals.map((r) => r.normalizedMerchant)).toEqual([
      "SPLITAPP",
    ]);
    // The clean merchant still got its rule — one refusal must not stop the rest.
    expect(exactRule("CLEANAPP")?.categoryId).toBe(subs.id);
    expect(exactRule("SPLITAPP")).toBeUndefined();
  });

  it("collects a throw into `failures` instead of abandoning the sweep", () => {
    /* Each merchant commits in its own transaction, so a propagating throw at
       iteration K left iterations 1..K-1 committed, every later merchant
       untouched, and no record anywhere of where it stopped. An unknown category
       makes `bulkCategorize` throw `CategoryNotFoundError` for every merchant,
       which is enough to prove the loop collects rather than propagates — and
       that it names each one. */
    const a = seedAccount();
    const b = seedBatch();
    for (const merchant of ["GOODAPP", "OTHERAPP"]) {
      for (const date of ["2026-01-15", "2026-02-15", "2026-03-15"]) {
        seedTxn({ accountId: a.id, batchId: b.id, merchant, date });
      }
    }

    const missingCategoryId = 99_999;
    const outcome = fileAllSubscriptions(handle.db, missingCategoryId);

    expect(outcome.failures.map((f) => f.normalizedMerchant).sort()).toEqual([
      "GOODAPP",
      "OTHERAPP",
    ]);
    expect(outcome.filedCount).toBe(0);
    expect(outcome.merchantsFiled).toBe(0);
    // Nothing was half-written: every row is still uncategorized.
    expect(
      handle.db
        .select()
        .from(schema.transactions)
        .all()
        .every((r) => r.categoryId === null),
    ).toBe(true);
  });
});

/**
 * A read that follows the committed write must not turn a filed merchant into
 * a reported failure — and this is the surface where that costs most.
 *
 * `fileAllSubscriptions` catches a per-merchant throw into `failures` (rule 6:
 * one transaction per merchant, so propagating would abandon every later one).
 * So an unguarded post-commit read here reported the merchant as FAILED after
 * `bulkCategorize` had already filed its rows and possibly repointed a
 * hand-trained rule — and `/subscriptions` has no undo anywhere, which makes
 * `refusal` / `retargetedRule` the only record either thing happened.
 *
 * Found by the review that fixed the same class in the two categorize actions;
 * this file held the fourth, fifth and sixth instances.
 */
describe("fileSubscription — a post-commit read failure keeps the write", () => {
  /** Fails every `select` from the moment the write's transaction commits,
   *  which is what `SQLITE_BUSY` looks like to this code. */
  function failReadsAfterCommit(): typeof handle.db {
    let armed = false;
    return new Proxy(handle.db, {
      get(target, prop, receiver) {
        if (prop === "select" && armed) {
          return () => {
            throw new Error("SQLITE_BUSY: database is locked");
          };
        }
        if (prop === "transaction") {
          const real = Reflect.get(target, prop, receiver) as typeof handle.db.transaction;
          return (...args: Parameters<typeof real>) => {
            const out = real.apply(target, args);
            armed = true;
            return out;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof handle.db;
  }

  it("still reports the merchant as FILED when the naming reads throw", () => {
    const a = seedAccount();
    const b = seedBatch();
    const books = seedCategory("Books");
    const subs = seedCategory("Subscriptions");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: books.id,
        matchType: "exact",
        matchValue: "AUDIBLE",
        priority: 50,
        source: "manual",
      })
      .run();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AUDIBLE", date: "2026-02-01" });

    const outcome = fileSubscription(failReadsAfterCommit(), "AUDIBLE", subs.id);

    // The rows are filed. Reporting a throw here would have said otherwise.
    expect(outcome.filedCount).toBeGreaterThan(0);
    expect(outcome.normalizedMerchant).toBe("AUDIBLE");
    // The rule WAS repointed, and the sentence saying so survives — degraded to
    // ids rather than names, which is still true, just less specific.
    expect(outcome.retargetedRule).not.toBeNull();
    expect(outcome.retargetedRule).toContain("AUDIBLE");
  });

  it("leaves the ledger written even though the message degraded", () => {
    const a = seedAccount();
    const b = seedBatch();
    const subs = seedCategory("Subscriptions");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "NETFLIX", date: "2026-02-01" });

    fileSubscription(failReadsAfterCommit(), "NETFLIX", subs.id);

    // Read back through the REAL handle: the write is durable regardless of
    // what the reporting reads did afterwards.
    const rows = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.categoryId, subs.id))
      .all();
    expect(rows.length).toBeGreaterThan(0);
  });
});
