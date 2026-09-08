import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { classifyKeyTrainability } from "./keyTrainability";
import { loadMerchantGroups } from "./loadMerchantGroups";
import {
  loadFiledCategoryIds,
  resolveKeyTrainability,
} from "./resolveKeyTrainability";

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
  amountCents: number;
  date?: string;
  categoryId?: number | null;
  transferPairId?: number | null;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-04-05",
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant,
      amountCents: opts.amountCents,
      categoryId: opts.categoryId ?? null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      transferPairId: opts.transferPairId ?? null,
      isPending: false,
    })
    .returning()
    .all();
  return row;
}

describe("loadFiledCategoryIds — archived categories", () => {
  it("does NOT count a filing under an archived category as evidence", () => {
    /* An archived category's rules never fire — `buildRuleMatcher` skips them
       (rule 8) — so a filing under one cannot contradict a live rule. Counting it
       refused Remember on a key whose only category that still matters is
       unanimous, with a message about two categories the user can no longer even
       pick from. */
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const retired = seedCategory("Retired");
    handle.db
      .update(schema.categories)
      .set({ archivedAt: new Date("2026-06-01T00:00:00.000Z") })
      .where(eq(schema.categories.id, retired.id))
      .run();

    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -1000,
      categoryId: groceries.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -2000,
      categoryId: retired.id,
    });

    expect(loadFiledCategoryIds(handle.db, "SAFEWAY")).toEqual([groceries.id]);
    expect(
      resolveKeyTrainability(handle.db, "SAFEWAY", groceries.id).trainable,
    ).toBe(true);
  });

  it("still counts a filing under a LIVE category", () => {
    // The control: same shape, nothing archived, so the refusal must stand.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -1000,
      categoryId: groceries.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -2000,
      categoryId: dining.id,
    });

    expect(loadFiledCategoryIds(handle.db, "SAFEWAY").sort()).toEqual(
      [groceries.id, dining.id].sort(),
    );
    expect(
      resolveKeyTrainability(handle.db, "SAFEWAY", groceries.id).trainable,
    ).toBe(false);
  });
});

describe("loadFiledCategoryIds", () => {
  it("returns nothing for a key the ledger has never seen", () => {
    expect(loadFiledCategoryIds(handle.db, "NOBODY")).toEqual([]);
  });

  it("returns nothing when every row for the key is still uncategorized", () => {
    const a = seedAccount();
    const b = seedBatch();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "NEWSHOP", amountCents: -1000 });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "NEWSHOP", amountCents: -2000 });

    // Empty is the answer, not a missing entry — an unfiled key is trainable.
    expect(loadFiledCategoryIds(handle.db, "NEWSHOP")).toEqual([]);
  });

  it("collapses repeated filings under one category to a single id", () => {
    // The SELECT DISTINCT is what keeps `classifyKeyTrainability`'s
    // `distinct.size >= 2` honest; without it, N filings would still be one
    // category but the row set would grow with the ledger for nothing.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    for (let i = 0; i < 5; i += 1) {
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "SAFEWAY",
        amountCents: -1000 - i,
        categoryId: groceries.id,
      });
    }

    expect(loadFiledCategoryIds(handle.db, "SAFEWAY")).toEqual([groceries.id]);
  });

  it("excludes transfer-paired rows", () => {
    // Same exclusion `loadMerchantGroups` applies. A second category reachable
    // only through a paired row is evidence `/categorize` never renders, so
    // refusing on it would disable a checkbox for an invisible reason.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const other = seedCategory("Other");
    const partner = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "PARTNER",
      amountCents: 4000,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -4000,
      categoryId: other.id,
      transferPairId: partner.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -1500,
      categoryId: groceries.id,
    });

    expect(loadFiledCategoryIds(handle.db, "SAFEWAY")).toEqual([groceries.id]);
  });

  it("matches the key exactly — a longer key sharing a prefix is a different merchant", () => {
    // `eq()`, never `like`. D2's exactness applies here too: `AMAZON` and
    // `AMAZON MKTPL` are separate keys, and bleeding one into the other would
    // manufacture a phantom second category.
    const a = seedAccount();
    const b = seedBatch();
    const shopping = seedCategory("Shopping");
    const homeGoods = seedCategory("HomeGoods");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -1000,
      categoryId: shopping.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON MKTPL",
      amountCents: -2000,
      categoryId: homeGoods.id,
    });

    expect(loadFiledCategoryIds(handle.db, "AMAZON")).toEqual([shopping.id]);
    expect(loadFiledCategoryIds(handle.db, "AMAZON MKTPL")).toEqual([
      homeGoods.id,
    ]);
  });

  it("treats the empty key as a real key rather than a wildcard", () => {
    // A blank Memo cell normalizes to "" (see `merchantLabel`). It must not
    // match every other key on the way past `eq()`.
    const a = seedAccount();
    const b = seedBatch();
    const misc = seedCategory("Misc");
    const groceries = seedCategory("Groceries");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "",
      amountCents: -1000,
      categoryId: misc.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -2000,
      categoryId: groceries.id,
    });

    expect(loadFiledCategoryIds(handle.db, "")).toEqual([misc.id]);
  });
});

describe("resolveKeyTrainability", () => {
  it("is trainable when the ledger's filings agree with the pending pick", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -4000,
      categoryId: groceries.id,
    });

    expect(
      resolveKeyTrainability(handle.db, "SAFEWAY", groceries.id).trainable,
    ).toBe(true);
  });

  it("is trainable for a key with no history at all", () => {
    const groceries = seedCategory("Groceries");
    expect(
      resolveKeyTrainability(handle.db, "BLOCK 21 WINERY", groceries.id)
        .trainable,
    ).toBe(true);
  });

  it("refuses when the PENDING pick is the second category", () => {
    // The union is the whole point: history alone is unanimous here, and the
    // category being assigned right now is what makes one exact rule unable to
    // be right.
    const a = seedAccount();
    const b = seedBatch();
    const amazon = seedCategory("Amazon");
    const homeGoods = seedCategory("HomeGoods");
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -4000,
      categoryId: amazon.id,
    });

    const verdict = resolveKeyTrainability(handle.db, "AMAZON", homeGoods.id);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    expect(verdict.reason).toBe("multi-category");
  });

  it("refuses a lossy key even when the ledger has never filed it", () => {
    const gifts = seedCategory("Gifts");
    const verdict = resolveKeyTrainability(handle.db, "ONLINE", gifts.id);
    expect(verdict.trainable).toBe(false);
    if (verdict.trainable) return;
    expect(verdict.reason).toBe("lossy-key");
  });

  it("does not refuse on a second category carried only by a transfer-paired row", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const other = seedCategory("Other");
    const partner = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "PARTNER",
      amountCents: 4000,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -4000,
      categoryId: other.id,
      transferPairId: partner.id,
    });

    expect(
      resolveKeyTrainability(handle.db, "SAFEWAY", groceries.id).trainable,
    ).toBe(true);
  });
});

describe("resolveKeyTrainability — agrees with what /categorize renders", () => {
  it("matches the client verdict built from loadMerchantGroups' filedCategoryIds", () => {
    // The contract named in `loadMerchantGroups`: `_merchant-row.tsx` runs the
    // pure predicate over `group.filedCategoryIds` + the picked category, and
    // the server runs it over `loadFiledCategoryIds` + the same category. A
    // divergence between the two queries renders an ENABLED checkbox whose
    // write is then refused — the exact failure the guard exists to prevent.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const other = seedCategory("Other");

    // Unanimous key, still with a backlog row so it appears in the groups.
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SAFEWAY",
      amountCents: -4000,
      categoryId: groceries.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY", amountCents: -1500 });

    // Already split across two categories.
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -4000,
      categoryId: groceries.id,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -2000,
      categoryId: dining.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -900 });

    // Lossy key.
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ONLINE", amountCents: -2500 });

    // Filed only through a transfer-paired row — excluded on both sides.
    const partner = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "PARTNER",
      amountCents: 4000,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "CHIPOTLE",
      amountCents: -4000,
      categoryId: other.id,
      transferPairId: partner.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "CHIPOTLE", amountCents: -1200 });

    const groups = loadMerchantGroups(handle.db);
    expect(groups.length).toBeGreaterThan(0);

    for (const group of groups) {
      for (const pick of [groceries.id, dining.id, other.id]) {
        const client = classifyKeyTrainability(
          group.normalizedMerchant,
          group.filedCategoryIds,
          pick,
        );
        const server = resolveKeyTrainability(
          handle.db,
          group.normalizedMerchant,
          pick,
        );
        expect({
          merchant: group.normalizedMerchant,
          pick,
          verdict: client,
        }).toEqual({
          merchant: group.normalizedMerchant,
          pick,
          verdict: server,
        });
      }
    }
  });
});
