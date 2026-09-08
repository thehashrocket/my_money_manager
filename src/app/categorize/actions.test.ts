import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import {
  bulkCategorize,
  type BulkCategorizeSnapshot,
} from "@/lib/categorize/bulkCategorize";
import { describeRuleRefusal } from "@/lib/categorize/refusalNotice";
import { undoBulkCategorize } from "@/lib/categorize/undoBulkCategorize";
import { validateBulkCategorizeInput } from "@/lib/categorize/validateBulkCategorizeInput";
import { bulkCategorizeSnapshotSchema } from "@/lib/categorize/validateBulkCategorizeSnapshot";

/**
 * The `/categorize` side of what `src/app/transactions/actions.test.ts` pins for
 * its own action: the boundary between what the server RETURNS and what the
 * client may send back as an undo snapshot. This file did not exist, so the
 * refusal fields `bulkCategorizeMerchantAction` grew were unpinned on this side.
 *
 * The action itself binds the module-level `db` singleton, so these tests drive
 * the same composition it does — validate the form input, run `bulkCategorize`,
 * build the snapshot, re-validate it — against an injected test database.
 */

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
  categoryId?: number | null;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: "2026-04-05",
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant,
      amountCents: -1200,
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

function snapshotOf(
  result: ReturnType<typeof bulkCategorize>,
): BulkCategorizeSnapshot {
  return {
    normalizedMerchant: result.normalizedMerchant,
    categoryId: result.categoryId,
    txnIds: result.txnIds,
    ruleTouched: result.ruleTouched,
    priorRule: result.priorRule,
    insertedRuleId: result.insertedRuleId,
    earliestDate: result.earliestDate,
  };
}

describe("bulk categorize snapshot boundary", () => {
  it("keeps ruleRefusal OUT of the snapshot, by type and by strict parse", () => {
    /* The refusal is a REASON, not state to reverse — `ruleTouched` +
       `priorRule` already carry everything the undo needs, including the case
       where the refusal removed a rule. Asserting `not.toHaveProperty` on a
       locally-built literal would be vacuous, so the claim is made against the
       TYPE and against the schema the undo re-validates. */
    const a = seedAccount();
    const b = seedBatch();
    const gifts = seedCategory("Gifts");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "ONLINE" });

    const parsed = validateBulkCategorizeInput({
      normalizedMerchant: "ONLINE",
      categoryId: String(gifts.id),
      rememberMerchant: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = bulkCategorize(handle.db, parsed.data, {
      allowRuleRemoval: true,
    });
    expect(result.ruleRefusal?.reason).toBe("lossy-key");

    const snapshot = snapshotOf(result);
    const _noRefusalInSnapshotType: Extract<
      keyof BulkCategorizeSnapshot,
      "ruleRefusal"
    > extends never
      ? true
      : never = true;
    expect(_noRefusalInSnapshotType).toBe(true);
    expect(
      bulkCategorizeSnapshotSchema
        .strict()
        .safeParse({ ...snapshot, ruleRefusal: result.ruleRefusal }).success,
    ).toBe(false);
    expect(bulkCategorizeSnapshotSchema.strict().safeParse(snapshot).success).toBe(
      true,
    );
  });

  it("survives the JSON round-trip a Server Action return value goes through", () => {
    // `priorRule`'s two `Date` columns are the only thing here that JSON cannot
    // represent, and the schema coerces them back — so a snapshot stashed by the
    // client for its 10s Undo window still validates.
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const dining = seedCategory("Dining");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "exact",
        matchValue: "SAFEWAY",
        priority: 80,
        source: "manual",
      })
      .run();
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const parsed = validateBulkCategorizeInput({
      normalizedMerchant: "SAFEWAY",
      categoryId: String(groceries.id),
      rememberMerchant: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = bulkCategorize(handle.db, parsed.data, {
      allowRuleRemoval: true,
    });
    expect(result.priorRule).not.toBeNull();

    const roundTripped = JSON.parse(JSON.stringify(snapshotOf(result)));
    const revalidated = bulkCategorizeSnapshotSchema.safeParse(roundTripped);
    expect(revalidated.success).toBe(true);
    if (!revalidated.success) return;

    // And it undoes for real, restoring the rule the upsert overwrote.
    expect(undoBulkCategorize(handle.db, revalidated.data).ruleAction).toBe(
      "restored",
    );
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(
          and(
            eq(schema.categoryRules.matchType, "exact"),
            eq(schema.categoryRules.matchValue, "SAFEWAY"),
          ),
        )
        .get()?.categoryId,
    ).toBe(dining.id);
  });

  it("round-trips the EMPTY key, which /categorize lists like any other group", () => {
    /* A blank bank memo normalizes to `""`, `loadMerchantGroups` groups it, and
       the page renders it as "(no merchant name)" with a working Submit. Both
       this input schema and the snapshot schema used to reject it, so that one
       group could be neither filed nor undone. */
    const a = seedAccount();
    const b = seedBatch();
    const misc = seedCategory("Misc");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "" });

    const parsed = validateBulkCategorizeInput({
      normalizedMerchant: "",
      categoryId: String(misc.id),
      rememberMerchant: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = bulkCategorize(handle.db, parsed.data, {
      allowRuleRemoval: true,
    });

    // Rows filed; rule refused, because `""` names nobody.
    expect(result.updatedCount).toBe(1);
    expect(result.ruleRefusal?.reason).toBe("lossy-key");

    const snapshot = snapshotOf(result);
    expect(bulkCategorizeSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(undoBulkCategorize(handle.db, snapshot).revertedCount).toBe(1);
  });
});

describe("what the action tells the user", () => {
  it("resolves the refusal into a sentence naming the removed rule's category", () => {
    // The action calls `describeRuleRefusal` because only the server can turn
    // the removed rule's category ID into its name, and that name is the fact
    // the user needs in order to decide whether to hit Undo.
    const a = seedAccount();
    const b = seedBatch();
    const dining = seedCategory("Dining");
    const groceries = seedCategory("Groceries");
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "exact",
        matchValue: "COSTCO WHSE",
        priority: 50,
        source: "manual",
      })
      .run();
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO WHSE",
      categoryId: dining.id,
    });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO WHSE" });

    const result = bulkCategorize(
      handle.db,
      {
        normalizedMerchant: "COSTCO WHSE",
        categoryId: groceries.id,
        rememberMerchant: true,
      },
      { allowRuleRemoval: true },
    );
    expect(result.ruleRefusal).not.toBeNull();
    if (result.ruleRefusal === null) return;

    const notice = describeRuleRefusal(handle.db, result.ruleRefusal);
    expect(notice.removedRule).toBe(true);
    expect(notice.message).toContain(dining.name);
    expect(notice.message).toContain("Undo restores it");
  });
});
