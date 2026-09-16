import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { classifyKeyTrainability, filedCategoryIdsAfterMove } from "./keyTrainability";
import { loadMerchantGroups } from "./loadMerchantGroups";
import { loadTransactions } from "./loadTransactions";
import {
  loadFiledCategoryIds,
  loadFiledCategoryIdsByMerchant,
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

describe("filedCategoryIdsAfterMove — parity with resolveKeyTrainability's excludeTxnIds", () => {
  // RetargetForm derives its verdict by dropping the FROM category's id out
  // of `filedCategoryIds` (`filedCategoryIdsAfterMove`) rather than passing
  // the moved rows' own ids as `excludeTxnIds` — the claim (keyTrainability.ts's
  // own docstring) is that these are mathematically identical, because
  // `bulkRetarget` moves EVERY non-transfer row filed under that category for
  // the merchant. This proves the claim against the real DB-backed exclusion
  // instead of leaving it as an unverified assertion in a comment.
  it("agrees with excludeTxnIds when the merchant stays split after the move", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const other = seedCategory("Other");

    const moving = [
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "AMAZON",
        amountCents: -4000,
        categoryId: groceries.id,
      }),
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "AMAZON",
        amountCents: -1500,
        categoryId: groceries.id,
      }),
    ];
    // Stays behind — the merchant is still split after the move.
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -900,
      categoryId: other.id,
    });

    const filedCategoryIds = loadFiledCategoryIds(handle.db, "AMAZON");
    const client = classifyKeyTrainability(
      "AMAZON",
      filedCategoryIdsAfterMove(filedCategoryIds, groceries.id),
      dining.id,
    );
    const server = resolveKeyTrainability(
      handle.db,
      "AMAZON",
      dining.id,
      moving.map((row) => row.id),
    );

    expect(client).toEqual(server);
    expect(client.trainable).toBe(false);
    if (client.trainable) return;
    expect(client.reason).toBe("multi-category");
  });

  it("agrees with excludeTxnIds when the move makes the key unanimous", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");

    // Every row for this merchant is filed under the category being moved
    // away from — nothing stays behind.
    const moving = [
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "SAFEWAY",
        amountCents: -4000,
        categoryId: groceries.id,
      }),
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "SAFEWAY",
        amountCents: -1500,
        categoryId: groceries.id,
      }),
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "SAFEWAY",
        amountCents: -900,
        categoryId: groceries.id,
      }),
    ];

    const filedCategoryIds = loadFiledCategoryIds(handle.db, "SAFEWAY");
    const client = classifyKeyTrainability(
      "SAFEWAY",
      filedCategoryIdsAfterMove(filedCategoryIds, groceries.id),
      dining.id,
    );
    const server = resolveKeyTrainability(
      handle.db,
      "SAFEWAY",
      dining.id,
      moving.map((row) => row.id),
    );

    expect(client).toEqual(server);
    expect(client.trainable).toBe(true);
  });

  it("is a no-op when nothing has been picked as the source yet", () => {
    const filedCategoryIds = [3, 7, 9];
    expect(filedCategoryIdsAfterMove(filedCategoryIds, null)).toEqual([
      3, 7, 9,
    ]);
  });

  // pr-test-analyzer (PR #61 review): the equivalence claim above was only
  // proven for a merchant with no archived-category or transfer-paired rows
  // in play — exactly the interaction `_retarget-form.tsx`'s own docstring
  // cites as the REASON `filedCategoryIds` had to be a separate prop from
  // `filed` in the first place (an archived category's rows are invisible to
  // `filedCategoryEvidenceWhere` but `bulkRetarget` still lets you move rows
  // OUT of one). Hand-traced to hold (both exclusions apply independently of
  // `excludeTxnIds`, so a row invisible to `filedCategoryIds` for either
  // reason contributes zero evidence either way) — pinned here rather than
  // left as a traced-but-unproven claim, matching this file's own bar for
  // every other consumer of `filedCategoryEvidenceWhere` (see the "archived
  // categories" and transfer-paired describe blocks above).
  it("agrees with excludeTxnIds when the FROM category is archived", () => {
    const a = seedAccount();
    const b = seedBatch();
    const archived = seedCategory("Old Category");
    handle.db
      .update(schema.categories)
      .set({ archivedAt: new Date() })
      .where(eq(schema.categories.id, archived.id))
      .run();
    const dining = seedCategory("Dining");

    const moving = [
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "AMAZON",
        amountCents: -4000,
        categoryId: archived.id,
      }),
    ];

    const filedCategoryIds = loadFiledCategoryIds(handle.db, "AMAZON");
    const client = classifyKeyTrainability(
      "AMAZON",
      filedCategoryIdsAfterMove(filedCategoryIds, archived.id),
      dining.id,
    );
    const server = resolveKeyTrainability(
      handle.db,
      "AMAZON",
      dining.id,
      moving.map((row) => row.id),
    );

    expect(client).toEqual(server);
    expect(client.trainable).toBe(true);
  });

  it("agrees with excludeTxnIds when a row in the FROM category is transfer-paired", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");

    const moving = [
      seedTxn({
        accountId: a.id,
        batchId: b.id,
        merchant: "AMAZON",
        amountCents: -4000,
        categoryId: groceries.id,
      }),
    ];
    // Filed under the same FROM category but transfer-paired — bulkRetarget's
    // own `matchingRows` query excludes it (isNull(transferPairId)), so it is
    // left behind by the move and must not count as still-filed evidence
    // either way.
    const partner = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "PARTNER",
      amountCents: 4000,
    });
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "AMAZON",
      amountCents: -4000,
      categoryId: groceries.id,
      transferPairId: partner.id,
    });

    const filedCategoryIds = loadFiledCategoryIds(handle.db, "AMAZON");
    const client = classifyKeyTrainability(
      "AMAZON",
      filedCategoryIdsAfterMove(filedCategoryIds, groceries.id),
      dining.id,
    );
    const server = resolveKeyTrainability(
      handle.db,
      "AMAZON",
      dining.id,
      moving.map((row) => row.id),
    );

    expect(client).toEqual(server);
    expect(client.trainable).toBe(true);
  });
});

describe("loadFiledCategoryIdsByMerchant", () => {
  it("returns an empty map for an empty merchant list, with no query", () => {
    expect(loadFiledCategoryIdsByMerchant(handle.db, [])).toEqual(new Map());
  });

  it("agrees with loadFiledCategoryIds per merchant — one query, same answer", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -1000, categoryId: groceries.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -2000, categoryId: dining.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SHELL", amountCents: -3000, categoryId: groceries.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "NEWPLACE", amountCents: -500 });

    const batched = loadFiledCategoryIdsByMerchant(handle.db, ["AMAZON", "SHELL", "NEWPLACE"]);

    expect(new Set(batched.get("AMAZON"))).toEqual(new Set([groceries.id, dining.id]));
    expect(batched.get("SHELL")).toEqual([groceries.id]);
    // A merchant with no filed evidence gets no map entry at all — callers
    // read that through `?? []`, matching `loadMerchantGroups`' own note that
    // the absent-entry case is not a fallback, it is the common answer.
    expect(batched.has("NEWPLACE")).toBe(false);

    for (const merchant of ["AMAZON", "SHELL", "NEWPLACE"]) {
      expect(new Set(batched.get(merchant) ?? [])).toEqual(
        new Set(loadFiledCategoryIds(handle.db, merchant)),
      );
    }
  });

  /* Testing specialist (ship review): the "conservative-only, never
     permissive" claim now lives on loadFiledCategoryCountsByMerchant's
     docstring — this pins it against loadFiledCategoryIdsByMerchant
     specifically, the non-self-excluding projection `/categorize` still
     uses (`/transactions` self-excludes via the counts version directly,
     see `loadTransactions.test.ts`'s own self-exclusion tests; that surface
     is not conservative-only anymore, it agrees with the server exactly).
     Nothing would fail here if a future change flipped this direction on
     the `/categorize` path, which would silently render its checkbox
     enabled for a write the server refuses (the exact class of bug this
     file exists to prevent). */
  it("loadFiledCategoryIdsByMerchant (the /categorize projection) is conservative, never permissive, relative to the server's own excludeTxnIds verdict", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const onlyFiledRow = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "SOLO MARKET",
      amountCents: -1500,
      categoryId: groceries.id,
    });

    // The /categorize projection has no excludeTxnIds: the row about to move
    // still counts as evidence, so retargeting it to a different category
    // reads as untrainable.
    const batched = loadFiledCategoryIdsByMerchant(handle.db, ["SOLO MARKET"]);
    const clientVerdict = classifyKeyTrainability(
      "SOLO MARKET",
      batched.get("SOLO MARKET") ?? [],
      dining.id,
    );
    expect(clientVerdict.trainable).toBe(false);

    // The server excludes exactly this row (it is the one being retargeted),
    // so the identical retarget is allowed.
    const serverVerdict = resolveKeyTrainability(handle.db, "SOLO MARKET", dining.id, [
      onlyFiledRow.id,
    ]);
    expect(serverVerdict.trainable).toBe(true);

    // The invariant that actually matters, asserted UNCONDITIONALLY. Ship
    // review, test-coverage pass (finding 2): a prior version of this check
    // lived inside `if (clientVerdict.trainable) {...}`, which the
    // `expect(clientVerdict.trainable).toBe(false)` two lines up makes DEAD
    // CODE — the body never runs, so a future change that made the client
    // MORE permissive than the server (the actual bug this pins against)
    // would pass silently. `!(client && !server)` is `client ⟹ server`,
    // evaluated every run regardless of which branch `clientVerdict` lands in.
    expect(clientVerdict.trainable && !serverVerdict.trainable).toBe(false);
  });

  it("the never-permissive check above is not vacuous — it also holds where the client verdict really is trainable", () => {
    // Proves the previous test's assertion is exercised with a TRUE
    // clientVerdict at least once in this suite, not only the
    // always-false case above (which is what made the original dead `if`
    // invisible: every existing test happened to leave it unevaluated).
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "FRESH MARKET", amountCents: -1000 });

    const batched = loadFiledCategoryIdsByMerchant(handle.db, ["FRESH MARKET"]);
    const clientVerdict = classifyKeyTrainability(
      "FRESH MARKET",
      batched.get("FRESH MARKET") ?? [],
      groceries.id,
    );
    expect(clientVerdict.trainable).toBe(true);

    const serverVerdict = resolveKeyTrainability(handle.db, "FRESH MARKET", groceries.id);
    expect(clientVerdict.trainable && !serverVerdict.trainable).toBe(false);
  });
});

/**
 * Cross-surface parity — `/categorize`'s `loadMerchantGroups` and
 * `/transactions`' `loadTransactions` both derive `filedCategoryIds` from
 * `loadFiledCategoryCountsByMerchant`, but through two different shapes: a
 * merchant group (`/categorize`, always `categoryId IS NULL`, nothing of its
 * own to self-exclude) versus an individual row (`/transactions`, which CAN
 * be an already-categorized row being retargeted, and self-excludes its own
 * sole-contributed category — see `filedCategoryIds`' docstring in
 * `loadTransactions.ts`). Parity holds for the UNCATEGORIZED case, which is
 * the only case `/categorize` ever renders; a categorized `/transactions` row
 * is EXPECTED to diverge from the group figure by exactly its own
 * self-excluded category, and that divergence is the fix, not a bug — a
 * silent regression back to the old, non-excluding behavior would make this
 * test agree again while reopening the retarget-blocking gap.
 */
describe("filedCategoryIds — parity between /categorize and /transactions", () => {
  it("an uncategorized /transactions row agrees with loadMerchantGroups exactly", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -1000, categoryId: groceries.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -2000, categoryId: dining.id });
    const uncategorized = seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -900 });

    const groups = loadMerchantGroups(handle.db);
    const amazonGroup = groups.find((g) => g.normalizedMerchant === "AMAZON");
    expect(amazonGroup).toBeDefined();

    const { rows } = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    const row = rows.find((r) => r.id === uncategorized.id);
    expect(new Set(row?.filedCategoryIds)).toEqual(new Set(amazonGroup?.filedCategoryIds));
  });

  it("a categorized /transactions row self-excludes its own sole-contributed category, unlike the group figure", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    const groceriesRow = seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -1000, categoryId: groceries.id });
    const diningRow = seedTxn({ accountId: a.id, batchId: b.id, merchant: "AMAZON", amountCents: -2000, categoryId: dining.id });

    const groups = loadMerchantGroups(handle.db);
    const amazonGroup = groups.find((g) => g.normalizedMerchant === "AMAZON");
    // Neither row is uncategorized, so /categorize's own backlog query never
    // groups this merchant at all — the group-level check above only exists
    // when there is an uncategorized row. Confirms the setup, not the fix.
    expect(amazonGroup).toBeUndefined();

    const { rows } = loadTransactions(handle.db, { page: 1, pageSize: 50 });
    const groceriesTxnRow = rows.find((r) => r.id === groceriesRow.id);
    const diningTxnRow = rows.find((r) => r.id === diningRow.id);
    // Each row sees the OTHER category as evidence, never its own — matching
    // `resolveKeyTrainability`'s own `excludeTxnIds=[row.id]` exactly.
    expect(groceriesTxnRow?.filedCategoryIds).toEqual([dining.id]);
    expect(diningTxnRow?.filedCategoryIds).toEqual([groceries.id]);
  });
});
