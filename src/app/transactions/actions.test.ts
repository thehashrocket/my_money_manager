import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { categorizeTransaction } from "@/lib/categorize/categorizeTransaction";
import { undoCategorizeTransaction } from "@/lib/categorize/undoCategorizeTransaction";
import { validateCategorizeTransactionInput } from "@/lib/categorize/validateCategorizeTransactionInput";
import { bulkRetarget } from "@/lib/categorize/bulkRetarget";
import type { BulkRetargetSnapshot } from "@/lib/categorize/bulkRetarget";
import { undoBulkRetarget } from "@/lib/categorize/undoBulkRetarget";
import { validateBulkRetargetInput } from "@/lib/categorize/validateBulkRetargetInput";
import { bulkRetargetSnapshotSchema } from "@/lib/categorize/validateBulkRetargetSnapshot";
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

function seedCategory(name: string) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({ name: `${name}-${seq}` })
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
 * The same mirror for `bulkRetargetAction` + `undoBulkRetargetAction`:
 *
 *   FormData → validate → bulkRetarget(db, {allowRuleRemoval}) → snapshot
 *   snapshot → JSON round-trip → validate → undoBulkRetarget(db)
 *
 * Both halves of that pipeline have their own suites; what neither can state
 * is that the ACTION wires them together correctly. The two things pinned
 * here are the two the sibling above was written for after each broke once:
 * the snapshot has to survive the Server Action serialization boundary and
 * re-validate on the way back in, and the `allowRuleRemoval` opt-in has to be
 * passed by the action rather than merely supported by the library.
 */
describe("bulkRetargetAction — end-to-end pipeline", () => {
  it("validates string FormData values, moves the rows, and the snapshot survives JSON", () => {
    const a = seedAccount();
    const b = seedBatch();
    const gas = seedCategory("Gas");
    const groceries = seedCategory("Groceries");
    const txn = seedTxn({ accountId: a.id, batchId: b.id, merchant: "COSTCO", categoryId: gas.id });

    // Exactly what `Object.fromEntries(formData)` hands the action: strings.
    const parsed = validateBulkRetargetInput({
      normalizedMerchant: "COSTCO",
      fromCategoryId: String(gas.id),
      categoryId: String(groceries.id),
      rememberMerchant: "true",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = bulkRetarget(handle.db, parsed.data, { allowRuleRemoval: true });
    expect(result.updatedCount).toBe(1);
    expect(result.fromCategoryName).toBe(gas.name);
    expect(result.categoryName).toBe(groceries.name);

    const snapshot: BulkRetargetSnapshot = {
      normalizedMerchant: result.normalizedMerchant,
      fromCategoryId: result.fromCategoryId,
      categoryId: result.categoryId,
      txnIds: result.txnIds,
      ruleTouched: result.ruleTouched,
      priorRule: result.priorRule,
      insertedRuleId: result.insertedRuleId,
      earliestDate: result.earliestDate,
    };

    /* The boundary. `priorRule.createdAt`/`updatedAt` are real `Date`s on the
       way out and ISO strings on the way back; `z.coerce.date()` is what makes
       that survivable, and a plain `z.date()` would fail here and nowhere
       else. */
    const reparsed = bulkRetargetSnapshotSchema.safeParse(
      JSON.parse(JSON.stringify(snapshot)),
    );
    expect(reparsed.success).toBe(true);
    if (!reparsed.success) return;

    const undone = undoBulkRetarget(handle.db, reparsed.data);
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
       it. Drop it from the action and every test in `bulkRetarget.test.ts`
       still passes while the wrong rule keeps auto-filing every future import
       — with the merchant kept off `/categorize` precisely BECAUSE the rule
       keeps filing it. */
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

    const result = bulkRetarget(
      handle.db,
      { normalizedMerchant: "COSTCO", fromCategoryId: gas.id, categoryId: groceries.id, rememberMerchant: true },
      { allowRuleRemoval: true },
    );

    expect(result.ruleRefusal).not.toBeNull();
    expect(result.priorRule?.categoryId).toBe(other.id);
    expect(
      handle.db
        .select()
        .from(schema.categoryRules)
        .where(eq(schema.categoryRules.matchValue, "COSTCO"))
        .all(),
    ).toHaveLength(0);
  });
});
