import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/**
 * Mirrors `categorizeTransactionAction` + `undoCategorizeTransactionAction`
 * minus the Next.js shell (`revalidatePath` closes over the singleton DB
 * and can't run under `:memory:`). Exercises the exact pipeline:
 *
 *   FormData → validate → categorizeTransaction(db) → snapshot
 *   snapshot → undoCategorizeTransaction(db)
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
