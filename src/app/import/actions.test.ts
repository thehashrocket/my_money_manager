import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { validateUpdateAnchorInput } from "@/lib/import/validateUpdateAnchorInput";
import { validateUndoImportCategorizationInput } from "@/lib/import/validateUndoImportCategorizationInput";
import { undoImportCategorization } from "@/lib/categorize/undoImportCategorization";

/**
 * Mirrors `updateAccountAnchorAction`'s mutation pipeline minus the Next.js
 * shell (`redirect`/`revalidatePath` close over the singleton DB and can't
 * run under `:memory:` — same convention as
 * src/app/transactions/actions.test.ts and src/app/budget/actions.test.ts).
 * Exercises the exact chain the action runs:
 *
 *   FormData → validateUpdateAnchorInput → UPDATE accounts SET ... WHERE id
 *
 * including the "0 rows changed" guard the action throws on for a stale/
 * deleted account id.
 */

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

function seedAccount(opts: {
  startingBalanceCents: number;
  startingBalanceDate: string;
}) {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: "Checking",
      type: "checking",
      startingBalanceCents: opts.startingBalanceCents,
      startingBalanceDate: opts.startingBalanceDate,
    })
    .returning()
    .all();
  return row;
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("updateAccountAnchorAction — validate → update pipeline", () => {
  it("moves the anchor back in time and converts dollars to cents", () => {
    const account = seedAccount({
      startingBalanceCents: 0,
      startingBalanceDate: "2026-09-03",
    });

    const parsed = validateUpdateAnchorInput(
      Object.fromEntries(
        formData({
          accountId: String(account.id),
          startingBalance: "984.12",
          startingBalanceDate: "2026-04-16",
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    handle.db
      .update(schema.accounts)
      .set({
        startingBalanceCents: Math.round(parsed.data.startingBalance * 100),
        startingBalanceDate: parsed.data.startingBalanceDate,
      })
      .where(eq(schema.accounts.id, parsed.data.accountId))
      .run();

    const updated = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(updated?.startingBalanceCents).toBe(98_412);
    expect(updated?.startingBalanceDate).toBe("2026-04-16");
  });

  it("reports zero rows changed for an id that doesn't exist — the guard the action throws on", () => {
    const parsed = validateUpdateAnchorInput(
      Object.fromEntries(
        formData({
          accountId: "999999",
          startingBalance: "1.00",
          startingBalanceDate: "2026-04-16",
        }),
      ),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = handle.db
      .update(schema.accounts)
      .set({ startingBalanceCents: 100, startingBalanceDate: "2026-04-16" })
      .where(eq(schema.accounts.id, parsed.data.accountId))
      .run();

    // The action throws `Account ${accountId} not found` on exactly this.
    expect(result.changes).toBe(0);
  });

  it("rejects malformed input before any UPDATE would run", () => {
    const account = seedAccount({
      startingBalanceCents: 12_345,
      startingBalanceDate: "2026-09-03",
    });

    const parsed = validateUpdateAnchorInput(
      Object.fromEntries(
        formData({
          accountId: String(account.id),
          startingBalance: "984.12",
          startingBalanceDate: "not-a-date",
        }),
      ),
    );
    expect(parsed.success).toBe(false);

    // The row is untouched — validation failing means the action never
    // reaches the UPDATE.
    const unchanged = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(unchanged?.startingBalanceCents).toBe(12_345);
    expect(unchanged?.startingBalanceDate).toBe("2026-09-03");
  });
});

/**
 * Mirrors `undoImportCategorizationAction`'s pipeline minus the Next.js shell
 * (same convention as the block above): FormData → validate → undo.
 */
describe("undoImportCategorizationAction — validate → undo pipeline", () => {
  function seedBatch() {
    const [row] = handle.db
      .insert(schema.importBatches)
      .values({ source: "csv", label: "seed.csv" })
      .returning()
      .all();
    return row;
  }

  it("reverts the batch's rule-matched rows via the same pipeline the action runs", () => {
    const account = seedAccount({ startingBalanceCents: 0, startingBalanceDate: "2026-01-01" });
    const batch = seedBatch();
    const [category] = handle.db
      .insert(schema.categories)
      .values({ name: "Groceries-action-test" })
      .returning()
      .all();
    const [txn] = handle.db
      .insert(schema.transactions)
      .values({
        accountId: account.id,
        date: "2026-04-05",
        rawDescription: "DESC",
        rawMemo: "MEMO",
        normalizedMerchant: "SAFEWAY",
        amountCents: -5000,
        categoryId: category.id,
        importSource: "csv",
        importBatchId: batch.id,
        importRowHash: "hash-1",
        isPending: false,
      })
      .returning()
      .all();
    handle.db
      .insert(schema.importBatchCategorizations)
      .values({ importBatchId: batch.id, transactionId: txn.id, categoryId: category.id })
      .run();

    const parsed = validateUndoImportCategorizationInput(
      Object.fromEntries(formData({ batchId: String(batch.id) })),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = undoImportCategorization(handle.db, parsed.data.batchId);
    expect(result).toEqual({ status: "reverted", revertedCount: 1, skippedCount: 0 });

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txn.id))
      .get();
    expect(after?.categoryId).toBeNull();
  });

  it("rejects a malformed batchId before undoImportCategorization would run", () => {
    const parsed = validateUndoImportCategorizationInput(
      Object.fromEntries(formData({ batchId: "not-a-number" })),
    );
    expect(parsed.success).toBe(false);
  });
});
