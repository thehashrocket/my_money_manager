import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { setAccountLink } from "./link";

let handle: TestDbHandle;

beforeEach(() => {
  handle = createTestDb();
});

afterEach(() => {
  handle.close();
});

function seedAccount(name: string) {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name,
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
    .values({ source: "simplefin", label: "simplefin 2026-01-01 00:00Z" })
    .returning()
    .all();
  return row;
}

let txnSeq = 0;
function seedTxn(opts: { accountId: number; batchId: number; externalId: string | null }) {
  txnSeq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: "2026-01-05",
      rawDescription: "DEPOSIT",
      rawMemo: `MEMO ${txnSeq}`,
      normalizedMerchant: `MEMO ${txnSeq}`,
      amountCents: 1000,
      importSource: "simplefin",
      importBatchId: opts.batchId,
      importRowHash: `hash-${txnSeq}`,
      externalId: opts.externalId,
    })
    .returning()
    .all();
  return row;
}

function read(id: number) {
  return handle.db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id))
    .get();
}

describe("setAccountLink", () => {
  it("links a local account to a SimpleFIN account id", () => {
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    expect(read(acct.id)?.simplefinAccountId).toBe("ACT-abc123");
  });

  it("unlinks when passed null, leaving the account CSV-only", () => {
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    setAccountLink(acct.id, null, handle.db);
    expect(read(acct.id)?.simplefinAccountId).toBeNull();
  });

  it("refuses to link a SimpleFIN account already claimed by another account", () => {
    // Guards the partial unique index — two local accounts pointing at one
    // feed account would double-import every row.
    const a = seedAccount("Checking");
    const b = seedAccount("Savings");
    setAccountLink(a.id, "ACT-abc123", handle.db);

    expect(() => setAccountLink(b.id, "ACT-abc123", handle.db)).toThrow(
      /already linked/i,
    );
    expect(read(b.id)?.simplefinAccountId).toBeNull();
  });

  it("allows re-saving the same link to the same account (idempotent)", () => {
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    expect(() => setAccountLink(acct.id, "ACT-abc123", handle.db)).not.toThrow();
    expect(read(acct.id)?.simplefinAccountId).toBe("ACT-abc123");
  });

  it("throws on an unknown local account rather than silently no-oping", () => {
    expect(() => setAccountLink(9999, "ACT-abc123", handle.db)).toThrow(
      /No such account/i,
    );
  });

  it("returns no warning on a fresh link with nothing to orphan", () => {
    const acct = seedAccount("Checking");
    const result = setAccountLink(acct.id, "ACT-abc123", handle.db);
    expect(result.warning).toBeNull();
  });

  it("clears external_id on unlink and warns that the freed-up rows are NOT safe from double-counting elsewhere", () => {
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    const txn = seedTxn({ accountId: acct.id, batchId: batch.id, externalId: "ext-1" });

    const result = setAccountLink(acct.id, null, handle.db);

    expect(result.warning).toMatch(/1 previously-imported transaction/i);
    expect(result.warning).toMatch(/double-count/i);
    const reread = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txn.id))
      .get();
    expect(reread?.externalId).toBeNull();
  });

  it("clears external_id when re-pointing the link to a different feed account, with the same double-count warning", () => {
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedTxn({ accountId: a.id, batchId: batch.id, externalId: "ext-1" });
    seedTxn({ accountId: a.id, batchId: batch.id, externalId: "ext-2" });

    const result = setAccountLink(a.id, "ACT-different", handle.db);

    expect(result.warning).toMatch(/2 previously-imported transactions/i);
    expect(result.warning).toMatch(/double-count/i);
    const remaining = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, a.id))
      .all();
    expect(remaining.every((r) => r.externalId === null)).toBe(true);
  });

  it("still warns on a second relink even though nothing is left to clear, because rows orphaned by the FIRST relink are still at risk", () => {
    // Regression test: the warning used to be gated on the UPDATE's own
    // `changes` count, which is 0 here (everything was already cleared by
    // the first relink) — so the warning silently vanished on exactly the
    // unlink/relink loop a troubleshooting user would run, right as the
    // exposed row count kept growing.
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedTxn({ accountId: a.id, batchId: batch.id, externalId: "ext-1" });

    const first = setAccountLink(a.id, "ACT-different", handle.db);
    expect(first.warning).toMatch(/1 previously-imported transaction/i);

    const second = setAccountLink(a.id, "ACT-yet-another", handle.db);
    expect(second.warning).toMatch(/1 previously-imported transaction/i);
    expect(second.warning).toMatch(/double-count/i);
  });

  it("relinking back to the account's original feed still warns while at-risk rows remain untagged", () => {
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedTxn({ accountId: a.id, batchId: batch.id, externalId: "ext-1" });

    setAccountLink(a.id, "ACT-different", handle.db);
    const back = setAccountLink(a.id, "ACT-abc123", handle.db);

    expect(back.warning).toMatch(/1 previously-imported transaction/i);
    const reread = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, a.id))
      .all();
    // Relinking back does not itself re-tag the row — only a resync (which
    // dedups it by content) would decide whether it stays untagged.
    expect(reread.every((r) => r.externalId === null)).toBe(true);
  });

  it("does not clear external_id or warn when re-saving the same link (idempotent)", () => {
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    const txn = seedTxn({ accountId: acct.id, batchId: batch.id, externalId: "ext-1" });

    const result = setAccountLink(acct.id, "ACT-abc123", handle.db);

    expect(result.warning).toBeNull();
    const reread = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txn.id))
      .get();
    expect(reread?.externalId).toBe("ext-1");
  });

  it("re-points a link with no warning when the old link never synced any rows", () => {
    // clearOrphaned is true (there was an old link), but the UPDATE matches
    // zero rows (no prior sync ever wrote a row on this account) — exercises
    // the `atRisk.length > 0` guard's false branch: no warning should be
    // manufactured just because a link existed.
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);

    const result = setAccountLink(acct.id, "ACT-different", handle.db);

    expect(result.warning).toBeNull();
    expect(read(acct.id)?.simplefinAccountId).toBe("ACT-different");
  });

  it("leaves another account's rows alone when re-pointing this account's link", () => {
    const a = seedAccount("Checking");
    const b = seedAccount("Savings");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    const otherTxn = seedTxn({ accountId: b.id, batchId: batch.id, externalId: "ext-b" });

    setAccountLink(a.id, null, handle.db);

    const reread = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, otherTxn.id))
      .get();
    expect(reread?.externalId).toBe("ext-b");
  });
});
