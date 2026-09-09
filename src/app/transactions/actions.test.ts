import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { categorizeTransaction } from "@/lib/categorize/categorizeTransaction";
import { undoCategorizeTransaction } from "@/lib/categorize/undoCategorizeTransaction";
import { validateCategorizeTransactionInput } from "@/lib/categorize/validateCategorizeTransactionInput";
import {
  runBulkRetarget,
  runUndoBulkRetarget,
} from "@/lib/categorize/runBulkRetarget";
import { categorizeTransactionSnapshotSchema } from "@/lib/categorize/validateCategorizeTransactionSnapshot";
import type { CategorizeTransactionSnapshot } from "@/lib/categorize/categorizeTransaction";
import { REFRESH_FAILED_WARNING } from "@/lib/revalidateAfterWrite";

/**
 * The action module binds the `@/db` singleton, which opens `./data/money.db`.
 * Redirecting that binding at a mutable holder — rather than mocking the
 * library functions the actions call — is what lets the refresh suites below
 * drive the REAL actions (input → write → snapshot → refresh) against the same
 * `:memory:` database the rest of this file uses. Mirroring an action by hand
 * is the exact shape that let `{ allowRuleRemoval: true }` be deleted with
 * 1,755 tests still green (see the `bulkRetargetAction` suite below), so it is
 * not repeated for the one line those suites are about.
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
           — the instant the COMMIT lands. Deliberately not a mock of
           `describeRuleRefusal`: the guard has to survive the real function
           doing its real (failing) lookup. */
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
const {
  bulkRetargetAction,
  categorizeTransactionAction,
  undoBulkRetargetAction,
  undoCategorizeTransactionAction,
} = await import("./actions");

/**
 * Mirrors `categorizeTransactionAction` + `undoCategorizeTransactionAction`
 * minus the Next.js shell. (`revalidatePath` is mocked for the refresh suite
 * at the bottom of this file, which drives the real actions; these earlier
 * suites predate it and compose the pipeline themselves.) Exercises the exact
 * pipeline:
 *
 *   FormData → validate → categorizeTransaction(db) → snapshot
 *   snapshot → undoCategorizeTransaction(db)
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

function seedCategory(
  name: string,
  opts: { kind?: "income" | "expense" | "fund" } = {},
) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-${seq}`, ...(opts.kind ? { kind: opts.kind } : {}) })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  merchant?: string;
  categoryId?: number | null;
  date?: string;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-04-05",
      rawDescription: "DESC",
      rawMemo: "MEMO",
      normalizedMerchant: opts.merchant ?? "SAFEWAY",
      amountCents: -1500,
      categoryId: opts.categoryId ?? null,
      importSource: "csv",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      isPending: false,
    })
    .returning()
    .all();
  return row;
}

describe("categorizeTransactionAction — end-to-end pipeline", () => {
  it("validates string FormData values and flips the target", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    // Simulates Object.fromEntries(formData) — all values are strings.
    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(groceries.id),
      rememberMerchant: "false",
      applyToPast: "false",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);

    expect(result.updatedCount).toBe(1);
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(row?.categoryId).toBe(groceries.id);
  });

  it("rejects tampered transactionId (non-integer)", () => {
    const parsed = validateCategorizeTransactionInput({
      transactionId: "abc",
      categoryId: "1",
    });
    expect(parsed.success).toBe(false);
  });

  it("applyToPast fans out to NULL siblings for the target's merchant", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const s1 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });
    const s2 = seedTxn({ accountId: a.id, batchId: b.id, merchant: "SAFEWAY" });

    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(groceries.id),
      applyToPast: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);

    expect(result.updatedCount).toBe(3);
    expect(result.applyToPastTxnIds.sort()).toEqual([s1.id, s2.id].sort());
  });

  it("round-trip: categorize → snapshot → undo restores the prior state", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const household = seedCategory("Household");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      categoryId: household.id,
    });

    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(groceries.id),
      rememberMerchant: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);
    const snapshot = {
      normalizedMerchant: result.normalizedMerchant,
      newCategoryId: result.newCategoryId,
      targetTxnId: result.targetTxnId,
      targetPriorCategoryId: result.targetPriorCategoryId,
      targetDate: result.targetDate,
      applyToPastTxnIds: result.applyToPastTxnIds,
      earliestApplyToPastDate: result.earliestApplyToPastDate,
      ruleTouched: result.ruleTouched,
      priorRule: result.priorRule,
      insertedRuleId: result.insertedRuleId,
    };

    undoCategorizeTransaction(handle.db, snapshot);

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(after?.categoryId).toBe(household.id);
    expect(handle.db.select().from(schema.categoryRules).where(eq(schema.categoryRules.matchType, "exact")).all()).toHaveLength(0);
  });

  it("returns a snapshot shaped to survive JSON round-trip (Server Action return value)", () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const target = seedTxn({ accountId: a.id, batchId: b.id });

    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(groceries.id),
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);

    const json = JSON.parse(
      JSON.stringify({
        normalizedMerchant: result.normalizedMerchant,
        newCategoryId: result.newCategoryId,
        targetTxnId: result.targetTxnId,
        targetPriorCategoryId: result.targetPriorCategoryId,
        targetDate: result.targetDate,
        applyToPastTxnIds: result.applyToPastTxnIds,
        earliestApplyToPastDate: result.earliestApplyToPastDate,
        ruleTouched: result.ruleTouched,
        priorRule: result.priorRule,
        insertedRuleId: result.insertedRuleId,
      }),
    );
    expect(json.targetTxnId).toBe(target.id);
    expect(json.newCategoryId).toBe(groceries.id);
    expect(json.priorRule).toBeNull();
  });
});

describe("categorizeTransactionAction — ruleRefusal pass-through", () => {
  it("survives the Server Action JSON round-trip and stays out of the snapshot", () => {
    // `_transaction-row.tsx` reads `result.ruleRefusal.message` on the client,
    // so the refusal has to cross the Server Action boundary as plain JSON —
    // and it must NOT be folded into the snapshot, which is the undo payload
    // and has nothing to restore for a rule that was never written.
    const a = seedAccount();
    const b = seedBatch();
    const gifts = seedCategory("Gifts");
    const target = seedTxn({ accountId: a.id, batchId: b.id, merchant: "ONLINE" });

    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(gifts.id),
      rememberMerchant: "true",
      applyToPast: "false",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);

    const snapshot: CategorizeTransactionSnapshot = {
      normalizedMerchant: result.normalizedMerchant,
      newCategoryId: result.newCategoryId,
      targetTxnId: result.targetTxnId,
      targetPriorCategoryId: result.targetPriorCategoryId,
      targetDate: result.targetDate,
      applyToPastTxnIds: result.applyToPastTxnIds,
      earliestApplyToPastDate: result.earliestApplyToPastDate,
      ruleTouched: result.ruleTouched,
      priorRule: result.priorRule,
      insertedRuleId: result.insertedRuleId,
    };
    /* `expect(snapshot).not.toHaveProperty("ruleRefusal")` was the obvious
       assertion and it was vacuous: `snapshot` is a literal built right here
       out of nine named fields, so it can never carry a tenth. The claim is
       about the type the ACTION returns and the schema the undo re-validates,
       so assert against both — a `ruleRefusal` added to
       `CategorizeTransactionSnapshot` fails the compile-time line, and one
       smuggled past the type at runtime fails the strict parse. */
    const _noRefusalInSnapshotType: Extract<
      keyof CategorizeTransactionSnapshot,
      "ruleRefusal"
    > extends never
      ? true
      : never = true;
    expect(_noRefusalInSnapshotType).toBe(true);
    expect(
      categorizeTransactionSnapshotSchema
        .strict()
        .safeParse({ ...snapshot, ruleRefusal: result.ruleRefusal }).success,
    ).toBe(false);
    expect(
      categorizeTransactionSnapshotSchema.strict().safeParse(snapshot).success,
    ).toBe(true);

    const json = JSON.parse(
      JSON.stringify({
        snapshot,
        updatedCount: result.updatedCount,
        categoryName: result.categoryName,
        ruleRefusal: result.ruleRefusal,
      }),
    );
    expect(json.ruleRefusal.reason).toBe("lossy-key");
    expect(typeof json.ruleRefusal.message).toBe("string");
    expect(json.ruleRefusal.message.length).toBeGreaterThan(0);
    // The rows were still filed — only the rule was withheld.
    expect(json.updatedCount).toBe(1);
  });

  it("undo after a refusal restores the row and touches no rule", () => {
    // `ruleTouched === false` is the only thing the undo path reads about
    // rules, so a refusal has to leave it false — otherwise the undo would
    // hunt for a `priorRule` that does not exist.
    const a = seedAccount();
    const b = seedBatch();
    const gifts = seedCategory("Gifts");
    const household = seedCategory("Household");
    const target = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "ONLINE",
      categoryId: household.id,
    });

    const parsed = validateCategorizeTransactionInput({
      transactionId: String(target.id),
      categoryId: String(gifts.id),
      rememberMerchant: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const result = categorizeTransaction(handle.db, parsed.data);
    expect(result.ruleRefusal).not.toBeNull();
    expect(result.ruleTouched).toBe(false);

    undoCategorizeTransaction(handle.db, {
      normalizedMerchant: result.normalizedMerchant,
      newCategoryId: result.newCategoryId,
      targetTxnId: result.targetTxnId,
      targetPriorCategoryId: result.targetPriorCategoryId,
      targetDate: result.targetDate,
      applyToPastTxnIds: result.applyToPastTxnIds,
      earliestApplyToPastDate: result.earliestApplyToPastDate,
      ruleTouched: result.ruleTouched,
      priorRule: result.priorRule,
      insertedRuleId: result.insertedRuleId,
    });

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, target.id))
      .get();
    expect(after?.categoryId).toBe(household.id);
    // Scoped to this key: the migrations seed a starter rule set, so a bare
    // "no rules at all" assertion would be measuring the seed, not the undo.
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "ONLINE"))
        .all(),
    ).toHaveLength(0);
  });
});

/**
 * `bulkRetargetAction` + `undoBulkRetargetAction`, driven through the REAL
 * pipeline — `runBulkRetarget` / `runUndoBulkRetarget`, which is everything
 * those two actions do except `revalidatePath`.
 *
 * This suite used to be a hand-written MIRROR: it re-declared
 * `{ allowRuleRemoval: true }` itself and called the library, so deleting the
 * opt-in from the action left every test green — while the docstring here
 * claimed to pin "the opt-in is passed by the action rather than merely
 * supported by the library". Verified during v0.23.0's review by doing exactly
 * that: 1,755/1,755 still passed. The same blindness covered the snapshot's
 * field list, which was re-typed by hand, so an action that dropped
 * `earliestDate` would also have passed.
 *
 * Extracting the body is what makes the claim true, because there is now only
 * one copy of it and this is the thing that calls it.
 */
describe("bulkRetargetAction — end-to-end pipeline", () => {
  it("validates string FormData values, moves the rows, and the snapshot survives JSON", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", categoryId: gas.id });

    // Exactly what `Object.fromEntries(formData)` hands the action: strings.
    const result = runBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: String(gas.id),
      categoryId: String(groceries.id),
      rememberMerchant: "true",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.updatedCount).toBe(1);
    expect(result.fromCategoryName).toBe(gas.name);
    expect(result.categoryName).toBe(groceries.name);

    /* The boundary. `priorRule.createdAt`/`updatedAt` are real `Date`s on the
       way out and ISO strings on the way back; `z.coerce.date()` is what makes
       that survivable, and a plain `z.date()` would fail here and nowhere
       else. Fed back through the real undo entry point, which re-validates —
       so the snapshot the action ACTUALLY emits has to satisfy the schema the
       action ACTUALLY applies. */
    const undone = runUndoBulkRetarget(
      handle.db,
      JSON.parse(JSON.stringify(result.snapshot)),
    );
    expect(undone.status).toBe("ok");
    if (undone.status !== "ok") return;
    expect(undone.revertedCount).toBe(1);
    expect(
      handle.db
        .select({ categoryId: schema.transactions.categoryId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, txn.id))
        .get()?.categoryId,
    ).toBe(gas.id);
  });

  it("passes allowRuleRemoval, so a contradicted rule goes with the rows", () => {
    /* Rule 6's discipline: the opt-in is an ARGUMENT and never a form field,
       and `/transactions`' retarget is one of only two callers that may set
       it. Because this drives `runBulkRetarget` rather than calling
       `bulkRetarget` with its own option object, dropping the opt-in from the
       pipeline FAILS here — which is the whole reason the body was extracted.
       Without it the wrong rule keeps auto-filing every future import, with
       the merchant kept off `/categorize` precisely BECAUSE the rule keeps
       filing it. */
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const other = seedCategory("Other");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", categoryId: gas.id });
    // A second filed category is what makes the key look split, so Remember
    // is refused — and the refusal is what may remove the rule.
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", categoryId: other.id });
    handle.db
      .insert(schema.categoryRules)
      .values({ categoryId: other.id, matchType: "exact", matchValue: "COSTCO", priority: 0, source: "manual" })
      .run();

    const result = runBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: String(gas.id),
      categoryId: String(groceries.id),
      rememberMerchant: "true",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.ruleRefusal).not.toBeNull();
    // Resolved to a finished sentence server-side, naming the category the
    // removed rule pointed at — the one fact a user needs to decide whether
    // to restore it.
    expect(result.ruleRefusal?.removedRule).toBe(true);
    expect(result.ruleRefusal?.message).toContain(other.name);
    expect(result.snapshot.priorRule?.categoryId).toBe(other.id);
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "COSTCO"))
        .all(),
    ).toHaveLength(0);
  });
});

/**
 * Refusals arrive as STATE, never as a throw.
 *
 * Next.js replaces a thrown Server Action's message with a generic digest in
 * production builds, and this app ships one (`Dockerfile` → `next start`), so
 * every sentence in `bulkRetargetErrors.ts` was dev-only text. These pin the
 * shape that actually reaches the browser.
 */
describe("bulkRetargetAction — refusals are returned, not thrown", () => {
  it("reports 'no rows' without throwing, and writes nothing", () => {
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");

    const result = runBulkRetarget(handle.db, {
      normalizedMerchant: "NOBODY",
      fromCategoryId: String(gas.id),
      categoryId: String(groceries.id),
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    // The message a person can act on, intact — this is the half production
    // used to delete, and its whole payload is "reload to see the counts".
    expect(result.message).toContain(gas.name);
    expect(result.message).toContain("Reload");
  });

  it("reports source === destination without throwing", () => {
    const gas = seedCategory("Gas");
    const result = runBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: String(gas.id),
      categoryId: String(gas.id),
    });
    expect(result.status).toBe("error");
  });

  it("reports a refusal on the DESTINATION category rather than throwing", () => {
    /* `assertAssignableCategory`'s four checks are defensive — the picker
       filters all of them out — so they only fire on a stale tab or a crafted
       post, which is exactly when a legible message matters most. */
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const fund = seedCategory("Emergency", { kind: "fund" });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", categoryId: gas.id });

    const result = runBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: String(gas.id),
      categoryId: String(fund.id),
    });
    expect(result.status).toBe("error");

    // And the rows did not move.
    expect(
      handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.categoryId, gas.id))
        .all(),
    ).toHaveLength(1);
  });

  it("reports an invalid undo snapshot without throwing", () => {
    const result = runUndoBulkRetarget(handle.db, { nonsense: true });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("Invalid undo snapshot");
  });

  it("refuses an undo whose priorRule belongs to a DIFFERENT merchant", () => {
    /* `undoBulkRetarget`'s row UPDATE is merchant-bounded; `restorePriorRule`
       was not, and its third mechanism (`onConflictDoUpdate` on
       (match_type, match_value)) REPOINTS whichever rule holds that slot. So a
       hand-edited payload could retarget an unrelated merchant's rule to an
       arbitrary category. Rows bounded, rules unbounded, in one function. */
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const result = runUndoBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: gas.id,
      categoryId: groceries.id,
      txnIds: [1],
      ruleTouched: true,
      priorRule: {
        id: 1,
        categoryId: groceries.id,
        matchType: "exact",
        matchValue: "SAFEWAY", // <- not COSTCO
        priority: 0,
        source: "manual",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      insertedRuleId: null,
      earliestDate: "2026-03-01",
    });
    expect(result.status).toBe("error");
  });

  /* The other half of that refinement, and the one it could break: a
     LEGITIMATE undo carrying a real removed rule has to pass. It does because
     `applyRuleWrite` only ever reads or deletes via `readExactRule` /
     `deleteExactRule` on the SAME key it was handed, and `match_value` has no
     `COLLATE NOCASE` (checked in `drizzle/0000`), so the stored value is a
     byte-for-byte match for the snapshot's merchant. Pinned because a
     collation change, or a caller that normalized the key differently on the
     two sides, would silently make every rule-restoring undo unreachable —
     and that undo is the only way back from a refusal that deleted a rule. */
  it("accepts a legitimate undo carrying the rule a refusal removed", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const other = seedCategory("Other");
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", categoryId: gas.id });
    seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", categoryId: other.id });
    handle.db
      .insert(schema.categoryRules)
      .values({ categoryId: other.id, matchType: "exact", matchValue: "COSTCO", priority: 0, source: "manual" })
      .run();

    const moved = runBulkRetarget(handle.db, {
      normalizedMerchant: "COSTCO",
      fromCategoryId: String(gas.id),
      categoryId: String(groceries.id),
      rememberMerchant: "true",
    });
    expect(moved.status).toBe("ok");
    if (moved.status !== "ok") return;
    expect(moved.snapshot.priorRule?.matchValue).toBe("COSTCO");

    // Through the real validator, via the JSON boundary the browser imposes.
    const undone = runUndoBulkRetarget(
      handle.db,
      JSON.parse(JSON.stringify(moved.snapshot)),
    );
    expect(undone.status).toBe("ok");
    if (undone.status !== "ok") return;
    expect(undone.ruleAction).toBe("restored");
    // The rule the refusal deleted is back, pointing where it did before.
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "COSTCO"))
        .get()?.categoryId,
    ).toBe(other.id);
  });
});

/**
 * A COMMITTED write whose refresh then fails is still a COMMITTED write — and
 * on these two actions that is not a cosmetic distinction.
 *
 * `revalidatePath` throws in this Next build, and its five calls sat AFTER the
 * write had committed but BEFORE the action returned its snapshot. A throw
 * therefore left the write in place and threw the snapshot away: the client's
 * `catch` rendered "Categorize failed." / "Move failed." for rows that had
 * moved, and the 10s Undo toast never appeared. Per rule 6 that same write can
 * have DELETED the merchant's trained rule, whose only surviving copy is
 * `snapshot.priorRule` — and with no rules-management surface anywhere, that
 * loss is permanent. `bulkRetarget` is the worst case, because it moves every
 * row for the merchant in one go.
 *
 * The mock has to THROW or there is nothing being tested: with a bare
 * `vi.fn()` every assertion here passes against the unguarded code too.
 */
describe("a failed refresh never costs /transactions its undo snapshot", () => {
  function throwOnRefresh() {
    vi.mocked(revalidatePath).mockImplementation(() => {
      throw new Error("revalidatePath blew up");
    });
  }

  function form(entries: Record<string, string>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  }

  it("categorizeTransactionAction returns the snapshot and a warning", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({ accountId: a.id, batchId: b.id });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    const result = await categorizeTransactionAction(
      form({
        transactionId: String(txn.id),
        categoryId: String(groceries.id),
        rememberMerchant: "true",
      }),
    );
    logged.mockRestore();

    expect(result.updatedCount).toBe(1);
    expect(result.snapshot.targetTxnId).toBe(txn.id);
    expect(result.snapshot.ruleTouched).toBe(true);
    expect(result.warning).toBe(REFRESH_FAILED_WARNING);
    // The write really landed, which is what makes losing the snapshot the
    // destructive outcome rather than a harmless one.
    expect(
      handle.db
        .select({ categoryId: schema.transactions.categoryId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, txn.id))
        .get()?.categoryId,
    ).toBe(groceries.id);
  });

  it("categorizeTransactionAction logs the refresh failure rather than swallowing it", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({ accountId: a.id, batchId: b.id });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    await categorizeTransactionAction(
      form({ transactionId: String(txn.id), categoryId: String(groceries.id) }),
    );

    expect(logged).toHaveBeenCalledWith(
      "[/transactions] revalidation failed after a committed write",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("reports no warning, and revalidates all five paths, when the refresh works", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({ accountId: a.id, batchId: b.id });

    const result = await categorizeTransactionAction(
      form({ transactionId: String(txn.id), categoryId: String(groceries.id) }),
    );

    expect(result.warning).toBeUndefined();
    for (const path of ["/transactions", "/categorize", "/goals", "/"]) {
      expect(revalidatePath).toHaveBeenCalledWith(path);
    }
    expect(revalidatePath).toHaveBeenCalledWith("/budget", "layout");
  });

  it("undoCategorizeTransactionAction carries the warning out of the UNDO too", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({ accountId: a.id, batchId: b.id });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const filed = await categorizeTransactionAction(
      form({ transactionId: String(txn.id), categoryId: String(groceries.id) }),
    );
    throwOnRefresh();
    const undo = await undoCategorizeTransactionAction(filed.snapshot);
    logged.mockRestore();

    expect(undo.targetReverted).toBe(true);
    expect(undo.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("bulkRetargetAction stays `ok` — snapshot, counts and names intact", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO",
      categoryId: gas.id,
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    throwOnRefresh();

    const result = await bulkRetargetAction(
      form({
        normalizedMerchant: "COSTCO",
        fromCategoryId: String(gas.id),
        categoryId: String(groceries.id),
        rememberMerchant: "true",
      }),
    );
    logged.mockRestore();

    // NOT `{ status: "error" }` — that arm is for refusals thrown BEFORE the
    // UPDATE, and reporting one here would deny a move that happened.
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.updatedCount).toBe(1);
    expect(result.snapshot.txnIds).toEqual([txn.id]);
    expect(result.snapshot.fromCategoryId).toBe(gas.id);
    expect(result.warning).toBe(REFRESH_FAILED_WARNING);
  });

  it("undoBulkRetargetAction stays `ok` and carries the warning", async () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "COSTCO",
      categoryId: gas.id,
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const moved = await bulkRetargetAction(
      form({
        normalizedMerchant: "COSTCO",
        fromCategoryId: String(gas.id),
        categoryId: String(groceries.id),
      }),
    );
    expect(moved.status).toBe("ok");
    if (moved.status !== "ok") return;

    throwOnRefresh();
    // Through the JSON boundary the browser imposes on a stashed snapshot.
    const undo = await undoBulkRetargetAction(
      JSON.parse(JSON.stringify(moved.snapshot)),
    );
    logged.mockRestore();

    expect(undo.status).toBe("ok");
    if (undo.status !== "ok") return;
    expect(undo.revertedCount).toBe(1);
    expect(undo.warning).toBe(REFRESH_FAILED_WARNING);
    expect(
      handle.db
        .select({ categoryId: schema.transactions.categoryId })
        .from(schema.transactions)
        .where(eq(schema.transactions.id, txn.id))
        .get()?.categoryId,
    ).toBe(gas.id);
  });

  it("a REFUSAL is still returned before any refresh, and carries no warning", async () => {
    // `runBulkRetarget` rejects this before the UPDATE, so nothing committed —
    // revalidating there would re-render the form out from under the only
    // rendering of the refusal (the /sync doctrine, four instances of which
    // were got wrong).
    const gas = seedCategory("Gas");
    throwOnRefresh();

    const result = await bulkRetargetAction(
      form({
        normalizedMerchant: "COSTCO",
        fromCategoryId: String(gas.id),
        categoryId: String(gas.id),
      }),
    );

    expect(result.status).toBe("error");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

/**
 * A COMMITTED write whose *description* then fails is still a COMMITTED write.
 *
 * Both write actions here resolve `ruleRefusal` through `describeRuleRefusal`
 * AFTER their transaction has landed, and that function READS THE DATABASE —
 * it names the category a removed rule pointed at. `SQLITE_BUSY` is live in
 * this app (WAL mode, `VACUUM INTO` snapshots, `pnpm db:export`, synchronous
 * driver), so the read can throw, and an unguarded throw rejected the whole
 * action: the client's `catch` rendered "Categorize failed." / "Move failed."
 * for a write that had landed, and the `snapshot` — returned below that call,
 * and per rule 6 the only surviving copy of a hand-trained rule this very
 * write DELETED — went out with it. There is no rules-management surface, so
 * that loss is permanent.
 *
 * `runBulkRetarget` had carried a guard for exactly this since it was written;
 * the other two call sites had not, and nothing about `describeRuleRefusal`'s
 * signature said it touched the database. The failure is injected at the
 * DRIVER rather than by mocking that function, so the guard is tested against
 * the real lookup really failing.
 */
describe("a post-commit read failure never costs /transactions its undo snapshot", () => {
  /** A merchant already filed under Dining, plus a live rule pointing there —
   *  so retargeting it to Groceries with Remember ticked refuses AND removes
   *  the contradicted rule. */
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
    const filed = seedTxn({
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
    return { dining, groceries, rule, filed, pending };
  }

  function form(entries: Record<string, string>) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  }

  it("categorizeTransactionAction returns the snapshot carrying the DELETED rule", async () => {
    const { groceries, rule, pending } = seedContradictedRule();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.failReadsAfterCommit = true;

    const result = await categorizeTransactionAction(
      form({
        transactionId: String(pending.id),
        categoryId: String(groceries.id),
        rememberMerchant: "true",
      }),
    );
    logged.mockRestore();

    expect(result.updatedCount).toBe(1);
    expect(result.snapshot.targetTxnId).toBe(pending.id);
    // THE POINT: the rule this write deleted survives only here.
    expect(result.snapshot.ruleTouched).toBe(true);
    expect(result.snapshot.priorRule?.id).toBe(rule.id);

    // The write landed, which is what makes losing the snapshot destructive.
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

  it("categorizeTransactionAction degrades the refusal instead of losing it", async () => {
    const { dining, groceries, pending } = seedContradictedRule();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.failReadsAfterCommit = true;

    const result = await categorizeTransactionAction(
      form({
        transactionId: String(pending.id),
        categoryId: String(groceries.id),
        rememberMerchant: "true",
      }),
    );
    logged.mockRestore();

    expect(result.ruleRefusal?.reason).toBe("multi-category");
    // `removedRule` survives the degrade — it is what tells the user the Undo
    // is worth pressing. Only the NAME, which needed the read, is gone.
    expect(result.ruleRefusal?.removedRule).toBe(true);
    expect(result.ruleRefusal?.message).toContain("COSTCO WHSE");
    expect(result.ruleRefusal?.message).not.toContain(dining.name);
  });

  it("categorizeTransactionAction logs the degraded read rather than swallowing it", async () => {
    const { groceries, pending } = seedContradictedRule();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.failReadsAfterCommit = true;

    await categorizeTransactionAction(
      form({
        transactionId: String(pending.id),
        categoryId: String(groceries.id),
        rememberMerchant: "true",
      }),
    );

    expect(logged).toHaveBeenCalledWith(
      "[/transactions] a read after a committed write failed; degrading the message",
      expect.any(Error),
    );
    logged.mockRestore();
  });

  it("bulkRetargetAction stays `ok` and keeps the removed rule's snapshot", async () => {
    /* A LOSSY key rather than the multi-category seed above, and the
       difference is rule 6: `bulkRetarget` passes the whole moved set as
       `excludeTxnIds`, so a move that makes the key unanimous RETRAINS the
       rule instead of removing it. `ONLINE` names nobody whatever the rows
       say, so it refuses — and a lossy refusal always removes. */
    const a = seedAccount();
    const b = seedBatch();
    const dining = seedCategory("Dining");
    const groceries = seedCategory("Groceries");
    const [rule] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "exact",
        matchValue: "ONLINE",
        priority: 50,
        source: "manual",
      })
      .returning()
      .all();
    const filed = seedTxn({
      accountId: a.id,
      batchId: b.id,
      merchant: "ONLINE",
      categoryId: dining.id,
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    dbHolder.failReadsAfterCommit = true;

    const result = await bulkRetargetAction(
      form({
        normalizedMerchant: "ONLINE",
        fromCategoryId: String(dining.id),
        categoryId: String(groceries.id),
        rememberMerchant: "true",
      }),
    );
    logged.mockRestore();

    // NOT `{ status: "error" }` — that arm is for refusals thrown BEFORE the
    // UPDATE, and reporting one here would deny a move that happened.
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.snapshot.txnIds).toEqual([filed.id]);
    expect(result.snapshot.priorRule?.id).toBe(rule.id);
    expect(result.ruleRefusal?.reason).toBe("lossy-key");
    expect(result.ruleRefusal?.removedRule).toBe(true);
    expect(result.ruleRefusal?.message).not.toContain(dining.name);
    // `categoryName`/`fromCategoryName` are read INSIDE the transaction, so
    // they are unaffected by a post-commit failure — the move still names
    // both ends of itself.
    expect(result.categoryName).toBe(groceries.name);
    expect(result.fromCategoryName).toBe(dining.name);
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.id, rule.id))
        .get(),
    ).toBeUndefined();
  });

  it("reports the full sentence, and no log, when the reads work", async () => {
    // The control: without it every assertion above could be satisfied by an
    // action that never described anything.
    const { dining, groceries, pending } = seedContradictedRule();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await categorizeTransactionAction(
      form({
        transactionId: String(pending.id),
        categoryId: String(groceries.id),
        rememberMerchant: "true",
      }),
    );

    expect(result.ruleRefusal?.message).toContain(dining.name);
    expect(result.ruleRefusal?.message).toContain("Undo restores it");
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
