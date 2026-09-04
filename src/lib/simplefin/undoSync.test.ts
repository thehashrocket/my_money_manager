import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { findLastSyncBatch, undoSyncBatch, undoLastSync } from "./undoSync";
import { linkTransfersByBucket, unlinkTransferPair } from "./sync";
import { deriveBatchLabel } from "@/lib/batchLabel";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

let seq = 0;

function seedAccount(name = "Checking") {
  seq += 1;
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: `${name}-${seq}`,
      type: "checking",
      startingBalanceCents: 0,
      startingBalanceDate: "2026-01-01",
    })
    .returning()
    .all();
  return row;
}

function seedBatch(source: "csv" | "simplefin", label: string | null) {
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source, label })
    .returning()
    .all();
  return row;
}

function seedTxn(opts: {
  accountId: number;
  batchId: number;
  amountCents: number;
  source?: "csv" | "simplefin";
  categoryId?: number | null;
  externalId?: string | null;
  rawMemo?: string;
  date?: string;
}) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date ?? "2026-09-01",
      rawDescription: opts.amountCents >= 0 ? "DEPOSIT" : "WITHDRAWAL",
      rawMemo: opts.rawMemo ?? `MEMO ${seq}`,
      normalizedMerchant: opts.rawMemo ?? `MEMO ${seq}`,
      amountCents: opts.amountCents,
      importSource: opts.source ?? "simplefin",
      importBatchId: opts.batchId,
      importRowHash: `hash-${seq}`,
      externalId: opts.externalId ?? null,
      categoryId: opts.categoryId ?? null,
    })
    .returning()
    .all();
  return row;
}

function seedCategory() {
  seq += 1;
  const [row] = handle.db
    .insert(schema.categories)
    .values({ name: `Groceries-${seq}` })
    .returning()
    .all();
  return row;
}

describe("findLastSyncBatch", () => {
  it("ignores CSV batches and reports the newest sync batch with its categorised count", () => {
    const account = seedAccount();
    const csv = seedBatch("csv", "starone.csv");
    seedTxn({ accountId: account.id, batchId: csv.id, amountCents: -100, source: "csv" });

    // A CSV-only database has nothing a sync undo could reverse.
    expect(findLastSyncBatch(handle.db)).toBeNull();

    const older = seedBatch("simplefin", "simplefin 2026-09-01 10:00Z");
    seedTxn({ accountId: account.id, batchId: older.id, amountCents: -200 });

    const newest = seedBatch("simplefin", "simplefin 2026-09-02 10:00Z");
    const category = seedCategory();
    seedTxn({ accountId: account.id, batchId: newest.id, amountCents: -300 });
    seedTxn({
      accountId: account.id,
      batchId: newest.id,
      amountCents: -400,
      categoryId: category.id,
    });

    const summary = findLastSyncBatch(handle.db);
    expect(summary?.batchId).toBe(newest.id);
    expect(summary?.label).toBe("simplefin 2026-09-02 10:00Z");
    expect(summary?.transactionCount).toBe(2);
    // The warning on the page ("that work is lost too") depends on this.
    expect(summary?.categorizedCount).toBe(1);
  });

  it("derives a display label from source + importedAt when the batch has none", () => {
    const account = seedAccount();
    const batch = seedBatch("simplefin", null);
    seedTxn({ accountId: account.id, batchId: batch.id, amountCents: -200 });

    const summary = findLastSyncBatch(handle.db);
    expect(summary?.label).toBe(
      deriveBatchLabel("simplefin", batch.importedAt),
    );
  });
});

describe("undoSyncBatch", () => {
  it("deletes the batch's rows and the batch itself, leaving everything else alone", () => {
    const account = seedAccount();
    const csv = seedBatch("csv", "starone.csv");
    const keep = seedTxn({
      accountId: account.id,
      batchId: csv.id,
      amountCents: -100,
      source: "csv",
    });

    const batch = seedBatch("simplefin", "simplefin 2026-09-02 10:00Z");
    seedTxn({ accountId: account.id, batchId: batch.id, amountCents: -200 });
    seedTxn({ accountId: account.id, batchId: batch.id, amountCents: -300 });

    expect(undoSyncBatch(batch.id, handle.db)).toEqual({
      status: "undone",
      batchId: batch.id,
      deletedCount: 2,
    });

    const remaining = handle.db.select().from(schema.transactions).all();
    expect(remaining.map((r) => r.id)).toEqual([keep.id]);
    // import_batch_id is ON DELETE RESTRICT, so the batch row can only go once
    // its transactions have.
    expect(
      handle.db
        .select()
        .from(schema.importBatches)
        .where(eq(schema.importBatches.id, batch.id))
        .get(),
    ).toBeUndefined();
  });

  it("unlinks a surviving CSV row that was transfer-paired to a deleted sync row", () => {
    const checking = seedAccount("Checking");
    const savings = seedAccount("Savings");
    const csv = seedBatch("csv", "starone.csv");
    const batch = seedBatch("simplefin", "simplefin 2026-09-02 10:00Z");

    const survivor = seedTxn({
      accountId: checking.id,
      batchId: csv.id,
      amountCents: 10000,
      source: "csv",
    });
    const doomed = seedTxn({
      accountId: savings.id,
      batchId: batch.id,
      amountCents: -10000,
    });

    for (const [id, pair] of [
      [survivor.id, doomed.id],
      [doomed.id, survivor.id],
    ]) {
      handle.db
        .update(schema.transactions)
        .set({ transferPairId: pair })
        .where(eq(schema.transactions.id, id))
        .run();
    }

    // ON DELETE SET NULL is what makes this safe; without it the delete would
    // fail or leave a dangling pointer at a row that no longer exists.
    expect(undoSyncBatch(batch.id, handle.db).status).toBe("undone");

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, survivor.id))
      .get();
    expect(after?.transferPairId).toBeNull();
  });

  it("refuses to undo a sync batch once a later import (of any source) exists", () => {
    // The scenario this guards: a sync lands, then a CSV import content-dedups
    // one of its own rows against a row THIS sync batch inserted (no source
    // filter on that dedup pass). If undo were still allowed, deleting the
    // sync batch would delete the only surviving copy of that transaction.
    const account = seedAccount();
    const batch = seedBatch("simplefin", "simplefin 2026-09-01 10:00Z");
    seedTxn({ accountId: account.id, batchId: batch.id, amountCents: -200 });

    // Still the newest batch — undo is offered and safe.
    expect(findLastSyncBatch(handle.db)?.batchId).toBe(batch.id);

    // A later CSV import lands.
    const laterCsv = seedBatch("csv", "starone.csv");
    seedTxn({ accountId: account.id, batchId: laterCsv.id, amountCents: -100, source: "csv" });

    // No longer offered at all — the page should not show an undo button.
    expect(findLastSyncBatch(handle.db)).toBeNull();

    // And even a direct call (stale form resubmission, a second tab) is
    // refused rather than silently deleting.
    const result = undoSyncBatch(batch.id, handle.db);
    expect(result.status).toBe("stale");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
    expect(
      handle.db
        .select()
        .from(schema.importBatches)
        .where(eq(schema.importBatches.id, batch.id))
        .get(),
    ).toBeDefined();
  });

  it("blocks undo of an older sync batch once a newer sync batch exists, even an empty one", () => {
    // A later batch of ANY source blocks undo of an earlier one — including
    // another sync run that landed zero new rows. The guard is "is anything
    // newer", not "did anything newer actually collide".
    const account = seedAccount();
    const older = seedBatch("simplefin", "simplefin 2026-09-01 10:00Z");
    seedTxn({ accountId: account.id, batchId: older.id, amountCents: -200 });

    const newer = seedBatch("simplefin", "simplefin 2026-09-02 10:00Z");

    // findLastSyncBatch now reports the newer (still-latest) batch, not the
    // older one — undo stays offered, just for the right batch.
    expect(findLastSyncBatch(handle.db)?.batchId).toBe(newer.id);
    expect(undoSyncBatch(older.id, handle.db).status).toBe("stale");
  });

  it("refuses to touch a batch that is not a sync batch, or one that does not exist", () => {
    const account = seedAccount();
    const csv = seedBatch("csv", "starone.csv");
    seedTxn({ accountId: account.id, batchId: csv.id, amountCents: -100, source: "csv" });

    expect(undoSyncBatch(csv.id, handle.db)).toEqual({ status: "nothing-to-undo" });
    expect(undoSyncBatch(9999, handle.db)).toEqual({ status: "nothing-to-undo" });
    // The CSV import is untouched.
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(1);
    // And undoLastSync agrees there is nothing to reverse.
    expect(undoLastSync(handle.db)).toEqual({ status: "nothing-to-undo" });
  });
});

describe("undo completeness — links a sync creates must not outlive it", () => {
  it("never links two pre-existing rows that undo could not unlink", () => {
    // matchTransfers sees every unlinked row in the window, so it can pair two
    // CSV rows that both predate the sync. undoSyncBatch deletes only the
    // batch's own rows, so such a pair would survive the undo permanently —
    // silently excluding both from spending with no way to clear it.
    const chk = seedAccount("Checking");
    const sav = seedAccount("Savings");
    const csv = seedBatch("csv", "old.csv");

    const a = seedTxn({
      accountId: chk.id, batchId: csv.id, amountCents: 10000,
      rawMemo: "POS 0901 1026 797230 SAVEMART #12 MA MANTECA", date: "2026-09-01",
    });
    const b = seedTxn({
      accountId: sav.id, batchId: csv.id, amountCents: -10000,
      rawMemo: "WITHDRAWAL-OVERDRAFT", date: "2026-09-01",
    });

    // An empty sync batch: no row of its own falls in this bucket.
    const syncBatch = seedBatch("simplefin", "simplefin 2026-09-02");
    const { pairsLinked } = linkTransfersByBucket("2026-08-01", handle.db, syncBatch.id);

    expect(pairsLinked).toBe(0);
    for (const id of [a.id, b.id]) {
      const row = handle.db
        .select().from(schema.transactions)
        .where(eq(schema.transactions.id, id)).get();
      expect(row?.transferPairId).toBeNull();
    }

    // Control: the same bucket DOES link once the batch owns one of the legs,
    // proving the guard is scoping by batch and not just refusing to link.
    const owned = seedTxn({
      accountId: sav.id, batchId: syncBatch.id, amountCents: -10000,
      rawMemo: "WITHDRAWAL-OVERDRAFT", date: "2026-09-01",
    });
    handle.db.update(schema.transactions)
      .set({ transferPairId: null })
      .where(eq(schema.transactions.id, b.id)).run();
    handle.db.delete(schema.transactions).where(eq(schema.transactions.id, b.id)).run();

    const second = linkTransfersByBucket("2026-08-01", handle.db, syncBatch.id);
    expect(second.pairsLinked).toBe(1);
    const linked = handle.db
      .select().from(schema.transactions)
      .where(eq(schema.transactions.id, owned.id)).get();
    expect(linked?.transferPairId).toBe(a.id);
  });

  it("undoing a sync batch nulls a surviving row's rejection marker instead of throwing a FK violation", () => {
    // A cross-source pair -- one leg CSV, one leg the sync batch about to be
    // undone -- that the user then rejected via "Not a transfer". transfer_
    // rejected_partner_id must be declared ON DELETE SET NULL, same as
    // transfer_pair_id, or deleting the sync leg here throws instead of
    // clearing the surviving CSV leg's marker.
    const chk = seedAccount("Checking");
    const sav = seedAccount("Savings");
    const csv = seedBatch("csv", "old.csv");
    const syncBatch = seedBatch("simplefin", "simplefin 2026-09-02");

    const csvLeg = seedTxn({ accountId: chk.id, batchId: csv.id, amountCents: 10000 });
    const syncLeg = seedTxn({ accountId: sav.id, batchId: syncBatch.id, amountCents: -10000 });

    handle.db.update(schema.transactions)
      .set({ transferPairId: syncLeg.id })
      .where(eq(schema.transactions.id, csvLeg.id)).run();
    handle.db.update(schema.transactions)
      .set({ transferPairId: csvLeg.id })
      .where(eq(schema.transactions.id, syncLeg.id)).run();

    unlinkTransferPair(csvLeg.id, handle.db);

    expect(() => undoSyncBatch(syncBatch.id, handle.db)).not.toThrow();

    const survivor = handle.db
      .select().from(schema.transactions)
      .where(eq(schema.transactions.id, csvLeg.id)).get();
    expect(survivor?.transferRejectedPartnerId).toBeNull();
  });
});
