import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { REFRESH_FAILED_WARNING } from "@/lib/revalidateAfterWrite";

import {
  bulkCategorize,
  type BulkCategorizeSnapshot,
} from "@/lib/categorize/bulkCategorize";
import { describeRuleRefusal } from "@/lib/categorize/refusalNotice";
import { undoBulkCategorize } from "@/lib/categorize/undoBulkCategorize";
import { validateBulkCategorizeInput } from "@/lib/categorize/validateBulkCategorizeInput";
import { bulkCategorizeSnapshotSchema } from "@/lib/categorize/validateBulkCategorizeSnapshot";

/**
 * The action module binds the `@/db` singleton, which opens `./data/money.db`.
 * Redirecting that binding at a mutable holder — rather than mocking the
 * library functions the action calls — is what lets the refresh tests below
 * drive the REAL pipeline (validate → `bulkCategorize` → snapshot → refresh)
 * against the same `:memory:` database the rest of this file uses. A
 * hand-written mirror of the action was exactly the shape that let
 * `{ allowRuleRemoval: true }` be deleted with every test still green (see
 * `runBulkRetarget`'s docstring), so it is not repeated here.
 *
 * The proxy mirrors `@/db`'s own: a plain `db: dbHolder.current` would capture
 * `undefined` at factory time, since the handle is created per-test.
 */
const dbHolder = vi.hoisted(() => ({
  current: null as unknown,
  /** Arm "the driver goes busy the moment this write commits". */
  failReadsAfterCommit: false,
  /** Set BY the proxy once the armed transaction has returned, i.e. committed. */
  readsFail: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db")>()),
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        const target = dbHolder.current as Record<string | symbol, unknown>;
        /* `SQLITE_BUSY`, simulated where it actually bites: on a read the
           action performs AFTER its write has committed. Failing every
           `select` from the start would just break the write and prove
           nothing, so the flag is flipped by the `transaction` wrapper below
           — the instant the COMMIT lands. This is deliberately not a mock of
           `describeRuleRefusal`: the guard has to survive the real function
           doing its real (failing) lookup, and it covers a second post-commit
           read (`/categorize`'s category-name select) that no such mock would
           reach. */
        if (dbHolder.readsFail && prop === "select") {
          return () => {
            throw new Error("SQLITE_BUSY: database is locked");
          };
        }
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (prop === "transaction" && dbHolder.failReadsAfterCommit) {
          return (...args: unknown[]) => {
            const out = (value as (...a: unknown[]) => unknown).apply(
              target,
              args,
            );
            dbHolder.readsFail = true;
            return out;
          };
        }
        return value.bind(target);
      },
    },
  ),
}));

const { revalidatePath } = await import("next/cache");
const { bulkCategorizeMerchantAction, undoBulkCategorizeAction } = await import(
  "./actions"
);

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
  dbHolder.current = handle.db;
  dbHolder.failReadsAfterCommit = false;
  dbHolder.readsFail = false;
  vi.mocked(revalidatePath).mockReset();
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

/**
 * A COMMITTED write whose refresh then fails is still a COMMITTED write — and
 * on this action that is not a cosmetic distinction.
 *
 * `revalidatePath` throws in this Next build, and these three calls sat AFTER
 * `bulkCategorize` had committed but BEFORE the action returned its snapshot.
 * A throw therefore left the write in place and threw the snapshot away: the
 * row's `catch` rendered "Categorize failed." for rows that had been filed,
 * and the 10s Undo toast never appeared. Per rule 6 that same write can have
 * DELETED the merchant's trained rule, whose only surviving copy is
 * `snapshot.priorRule` — and there is no rules-management surface to rebuild
 * it from, so the loss is permanent.
 *
 * The mock has to THROW or there is nothing being tested: with a bare
 * `vi.fn()` these assertions pass against the unguarded code too.
 */
describe("bulkCategorizeMerchantAction — a failed refresh keeps the undo snapshot", () => {
  function seedFilableRow() {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    return { groceries, txn };
  }

  function form(categoryId: number) {
    const fd = new FormData();
    fd.set("normalizedMerchant", "SAFEWAY");
    fd.set("categoryId", String(categoryId));
    fd.set("rememberMerchant", "true");
    return fd;
  }

  function throwOnRefresh() {
    vi.mocked(revalidatePath).mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });
  }

  it("still returns the snapshot, the count and the rule id when the refresh throws", async () => {
    const { groceries, txn } = seedFilableRow();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    const result = await bulkCategorizeMerchantAction(form(groceries.id));
    logged.mockRestore();

    // Not a throw (which would hit `/categorize/error.tsx`) and not an empty
    // result — the rows were filed, so the Undo has to be offerable.
    expect(result.updatedCount).toBe(1);
    expect(result.snapshot.txnIds).toEqual([txn.id]);
    expect(result.snapshot.ruleTouched).toBe(true);
    expect(result.snapshot.insertedRuleId).not.toBeNull();
    expect(result.warning).toBe(REFRESH_FAILED_WARNING);

    // And the write really did land, which is what makes discarding the
    // snapshot the destructive outcome rather than a harmless one.
    const stored = handle.db
      .select({ categoryId: schema.transactions.categoryId })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txn.id))
      .get();
    expect(stored?.categoryId).toBe(groceries.id);
  });

  it("does not swallow the refresh failure silently", async () => {
    const { groceries } = seedFilableRow();
    // The developer-facing half. A failing `revalidatePath` is a bug in this
    // app, not a user error, and the returned sentence is aimed at someone who
    // cannot act on it.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    await bulkCategorizeMerchantAction(form(groceries.id));

    expect(logged).toHaveBeenCalledWith(
      "[/categorize] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("reports no warning, and revalidates all three paths, when the refresh works", async () => {
    const { groceries } = seedFilableRow();

    const result = await bulkCategorizeMerchantAction(form(groceries.id));

    expect(result.warning).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/categorize");
    expect(revalidatePath).toHaveBeenCalledWith("/transactions");
    expect(revalidatePath).toHaveBeenCalledWith("/budget", "layout");
  });

  it("carries the warning out of the UNDO too, which restores the removed rule", async () => {
    const { groceries, txn } = seedFilableRow();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const filed = await bulkCategorizeMerchantAction(form(groceries.id));
    throwOnRefresh();
    const undo = await undoBulkCategorizeAction(filed.snapshot);
    logged.mockRestore();

    // The revert happened; only the page is stale.
    expect(undo.revertedCount).toBe(1);
    expect(undo.warning).toBe(REFRESH_FAILED_WARNING);
    const stored = handle.db
      .select({ categoryId: schema.transactions.categoryId })
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txn.id))
      .get();
    expect(stored?.categoryId).toBeNull();
  });
});

/**
 * A COMMITTED write whose *description* then fails is still a COMMITTED write.
 *
 * `bulkCategorizeMerchantAction` performs TWO reads after its transaction has
 * landed — the category's name for the toast, and `describeRuleRefusal`, which
 * looks up the name of the category a REMOVED rule pointed at. `SQLITE_BUSY`
 * is live in this app (WAL mode, `VACUUM INTO` snapshots, `pnpm db:export`,
 * synchronous driver), so either can throw, and either throw used to reject
 * the whole action. The client's `catch` then put the backlog counter back and
 * said "Categorize failed." — for rows that were filed and, per rule 6, for a
 * hand-trained rule that had just been DELETED. Its only surviving copy is
 * `snapshot.priorRule`, in the value being thrown away, and there is no
 * rules-management surface to rebuild it from.
 *
 * The failure is injected at the DRIVER rather than by mocking
 * `describeRuleRefusal`, for two reasons: the guard has to hold with the real
 * function doing its real lookup, and only a driver-level failure also reaches
 * the second post-commit read (the category-name select) that no mock of that
 * one function would touch.
 */
describe("bulkCategorizeMerchantAction — a post-commit read failure keeps the write", () => {
  /** The rule-removing refusal: a key already filed under Dining, retargeted
   *  to Groceries with Remember ticked, so the contradicted rule goes. */
  function seedContradictedRule() {
    const a = seedAccount();
    const b = seedBatch();
    const dining = seedCategory("Dining");
    const groceries = seedCategory("Groceries");
    const [rule] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "exact",
        matchValue: "COSTCO WHSE",
        priority: 50,
        source: "manual",
      })
      .returning()
      .all();
    seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO WHSE",
      categoryId: dining.id,
    });
    const pending = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO WHSE",
    });
    return { dining, groceries, rule, pending };
  }

  function form(categoryId: number) {
    const fd = new FormData();
    fd.set("normalizedMerchant", "COSTCO WHSE");
    fd.set("categoryId", String(categoryId));
    fd.set("rememberMerchant", "true");
    return fd;
  }

  it("still returns the undo snapshot carrying the DELETED rule", async () => {
    const { groceries, rule, pending } = seedContradictedRule();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.failReadsAfterCommit = true;

    const result = await bulkCategorizeMerchantAction(form(groceries.id));
    logged.mockRestore();

    // Not a rejection (which the row's catch renders as "Categorize failed.").
    expect(result.updatedCount).toBe(1);
    expect(result.snapshot.txnIds).toEqual([pending.id]);
    // THE POINT. The rule was deleted by this write and this object is the
    // only copy of it left anywhere; losing it is unrecoverable.
    expect(result.snapshot.ruleTouched).toBe(true);
    expect(result.snapshot.priorRule?.id).toBe(rule.id);
    expect(result.snapshot.priorRule?.categoryId).toBe(rule.categoryId);

    // And the write really did land, which is what makes discarding the
    // snapshot destructive rather than harmless.
    expect(
      handle.db
        .select({ categoryId: schema.transactions.categoryId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, pending.id))
        .get()?.categoryId,
    ).toBe(groceries.id);
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.id, rule.id))
        .get(),
    ).toBeUndefined();
  });

  it("degrades the refusal to its own sentence instead of losing it", async () => {
    const { dining, groceries } = seedContradictedRule();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.failReadsAfterCommit = true;

    const result = await bulkCategorizeMerchantAction(form(groceries.id));
    logged.mockRestore();

    expect(result.ruleRefusal).not.toBeNull();
    expect(result.ruleRefusal?.reason).toBe("multi-category");
    // `removedRule` survives the degrade — it is what tells the user the Undo
    // is worth pressing. Only the NAME, which needed the read, is gone.
    expect(result.ruleRefusal?.removedRule).toBe(true);
    expect(result.ruleRefusal?.message).toContain("COSTCO WHSE");
    expect(result.ruleRefusal?.message).not.toContain(dining.name);
  });

  it("degrades the category NAME to its id rather than rejecting", async () => {
    const { groceries } = seedContradictedRule();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.failReadsAfterCommit = true;

    const result = await bulkCategorizeMerchantAction(form(groceries.id));
    logged.mockRestore();

    // The `?? \`Category N\`` fallback covered a MISSING row; it never covered
    // the read itself throwing, which is the case this asserts.
    expect(result.categoryName).toBe(`Category ${groceries.id}`);
  });

  it("does not fail silently — both degraded reads are logged", async () => {
    const { groceries } = seedContradictedRule();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.failReadsAfterCommit = true;

    await bulkCategorizeMerchantAction(form(groceries.id));

    expect(logged).toHaveBeenCalledWith(
      "[/categorize] a read after a committed write failed; degrading the message",
      expect.any(Error),
    );
    // Twice: the category-name select AND `describeRuleRefusal`'s own lookup.
    expect(logged.mock.calls.length).toBeGreaterThanOrEqual(2);
    logged.mockRestore();
  });

  it("reports the full sentence, and the real name, when the reads work", async () => {
    // The control. Without it these assertions could all be satisfied by an
    // action that never described anything.
    const { dining, groceries } = seedContradictedRule();

    const result = await bulkCategorizeMerchantAction(form(groceries.id));

    expect(result.categoryName).toBe(groceries.name);
    expect(result.ruleRefusal?.message).toContain(dining.name);
    expect(result.ruleRefusal?.message).toContain("Undo restores it");
  });
});
