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
function seedTxn(opts: {
  accountId: number;
  batchId: number;
  externalId: string | null;
  /** Defaults to the account's link at seed time, as the real write path does. */
  simplefinSourceAccountId?: string | null;
  /** Defaults to "simplefin"; the legacy-orphan query filters on this. */
  source?: "csv" | "simplefin" | "manual";
}) {
  txnSeq += 1;
  const linkedFeedId = opts.externalId
    ? (handle.db
        .select({ feedId: schema.accounts.simplefinAccountId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, opts.accountId))
        .get()?.feedId ?? null)
    : null;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: "2026-01-05",
      rawDescription: "DEPOSIT",
      rawMemo: `MEMO ${txnSeq}`,
      normalizedMerchant: `MEMO ${txnSeq}`,
      amountCents: 1000,
      importSource: opts.source ?? "simplefin",
      importBatchId: opts.batchId,
      importRowHash: `hash-${txnSeq}`,
      externalId: opts.externalId,
      simplefinSourceAccountId:
        opts.simplefinSourceAccountId !== undefined
          ? opts.simplefinSourceAccountId
          : linkedFeedId,
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

  it("KEEPS external_id and its feed tag on unlink, and warns about nothing", () => {
    // Inverted from the pre-provenance behaviour, which cleared the tag here
    // and then warned that the now-untagged rows could be double-counted. The
    // clearing was the cause of that exposure, not a mitigation of it.
    const acct = seedAccount("Checking");
    setAccountLink(acct.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    const txn = seedTxn({ accountId: acct.id, batchId: batch.id, externalId: "ext-1" });

    const result = setAccountLink(acct.id, null, handle.db);

    expect(result.warning).toBeNull();
    const reread = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, txn.id))
      .get();
    expect(reread?.externalId).toBe("ext-1");
    expect(reread?.simplefinSourceAccountId).toBe("ACT-abc123");
  });

  it("keeps every row's ORIGINAL feed tag when re-pointing to a different feed", () => {
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedTxn({ accountId: a.id, batchId: batch.id, externalId: "ext-1" });
    seedTxn({ accountId: a.id, batchId: batch.id, externalId: "ext-2" });

    const result = setAccountLink(a.id, "ACT-different", handle.db);

    expect(result.warning).toBeNull();
    const remaining = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, a.id))
      .all();
    // The account now points at ACT-different; both rows still came from
    // ACT-abc123, which is the fact the double-count fix depends on.
    expect(remaining.every((r) => r.externalId !== null)).toBe(true);
    expect(remaining.every((r) => r.simplefinSourceAccountId === "ACT-abc123")).toBe(true);
  });

  it("stays silent across an unlink/relink loop, the case that used to grow the exposed row count", () => {
    // Regression test, kept and inverted. The warning used to be gated on the
    // clearing UPDATE's own `changes` count, so it vanished on exactly this
    // loop while the number of stripped rows kept climbing. There is now
    // nothing to strip, so there is nothing to warn about — and the assertion
    // that matters is that the rows come out the other side intact.
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedTxn({ accountId: a.id, batchId: batch.id, externalId: "ext-1" });

    expect(setAccountLink(a.id, "ACT-different", handle.db).warning).toBeNull();
    expect(setAccountLink(a.id, "ACT-yet-another", handle.db).warning).toBeNull();
    expect(setAccountLink(a.id, "ACT-abc123", handle.db).warning).toBeNull();

    const reread = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, a.id))
      .all();
    expect(reread).toHaveLength(1);
    expect(reread[0].externalId).toBe("ext-1");
    expect(reread[0].simplefinSourceAccountId).toBe("ACT-abc123");
  });

  it("still warns about LEGACY orphans — rows a pre-provenance relink already stripped", () => {
    // The one case the fix cannot repair: the feed a stripped row came from is
    // unknowable after the fact. Nothing creates these any more, so this set
    // can only shrink, but while it is non-empty it carries the old exposure.
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedTxn({
      accountId: a.id,
      batchId: batch.id,
      externalId: null,
      simplefinSourceAccountId: null,
    });

    const result = setAccountLink(a.id, "ACT-different", handle.db);

    expect(result.warning).toMatch(/1 transaction/i);
    expect(result.warning).toMatch(/before de-dup tags were recorded/i);
    expect(result.warning).toMatch(/no longer creates this/i);
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
    // The link changed (there was an old one), but the account holds no rows
    // at all — exercises the `atRisk.length > 0` guard's false branch: no
    // warning should be manufactured just because a link existed.
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

/**
 * The legacy-orphan warning is the ONE thing `setAccountLink` still reports,
 * and every clause of its query is load-bearing: it names a count the user is
 * asked to act on. The pre-provenance tests covered the plural wording via the
 * clearing path that no longer exists, so the branch lost its only exercise
 * when the clearing went away.
 */
describe("setAccountLink — the legacy-orphan warning's own predicates", () => {
  /** A row a PRE-0020 relink stripped: simplefin-sourced, no id, no feed tag. */
  function seedLegacyOrphan(accountId: number, batchId: number) {
    return seedTxn({
      accountId,
      batchId,
      externalId: null,
      simplefinSourceAccountId: null,
    });
  }

  it("uses PLURAL wording for more than one legacy orphan", () => {
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedLegacyOrphan(a.id, batch.id);
    seedLegacyOrphan(a.id, batch.id);

    const result = setAccountLink(a.id, "ACT-different", handle.db);

    expect(result.warning).toMatch(/2 transactions/);
    expect(result.warning).toMatch(/were imported/);
    expect(result.warning).toMatch(/as duplicates/);
    expect(result.warning).toMatch(/delete them here/);
  });

  it("does NOT count CSV rows, which have no external_id by construction", () => {
    // Without the import_source filter every CSV row on the account would be
    // reported as a stripped sync row — a scary, permanent, false warning on
    // any ledger that imports files at all.
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedTxn({ accountId: a.id, batchId: batch.id, externalId: null, source: "csv" });

    expect(setAccountLink(a.id, "ACT-different", handle.db).warning).toBeNull();
  });

  it("does NOT count another account's legacy orphans", () => {
    const a = seedAccount("Checking");
    const b = seedAccount("Savings");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedLegacyOrphan(b.id, batch.id);

    expect(setAccountLink(a.id, "ACT-different", handle.db).warning).toBeNull();
  });

  it("stays silent when the link did NOT change, orphans or not", () => {
    // The warning is about a link MOVE. Re-saving the same value must not nag
    // about rows the move-that-did-not-happen cannot expose.
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedLegacyOrphan(a.id, batch.id);

    expect(setAccountLink(a.id, "ACT-abc123", handle.db).warning).toBeNull();
  });

  it("warns on UNLINK too — freeing the feed is exactly when they get exposed", () => {
    const a = seedAccount("Checking");
    setAccountLink(a.id, "ACT-abc123", handle.db);
    const batch = seedBatch();
    seedLegacyOrphan(a.id, batch.id);

    const result = setAccountLink(a.id, null, handle.db);

    expect(result.warning).toMatch(/1 transaction on this account was imported/);
    expect(read(a.id)?.simplefinAccountId).toBeNull();
  });
});
