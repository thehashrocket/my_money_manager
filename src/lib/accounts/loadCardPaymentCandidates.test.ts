import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadCardPaymentCandidates } from "./loadCardPaymentCandidates";

let handle: TestDbHandle;
let seq = 0;

beforeEach(() => {
  handle = createTestDb();
  seq = 0;
});
afterEach(() => handle.close());

function seedAccount(name: string, type: "checking" | "credit" = "credit") {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name,
      type,
      startingBalanceCents: type === "checking" ? 500_000 : -200_000,
      startingBalanceDate: "2026-08-01",
    })
    .returning()
    .all();
  return row;
}

function seedRow(accountId: number, date: string, amountCents: number, transferPairId: number | null = null) {
  seq += 1;
  const [batch] = handle.db
    .insert(schema.importBatches)
    .values({ source: "simplefin", label: `seed.${seq}` })
    .returning()
    .all();
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId,
      date,
      rawDescription: amountCents > 0 ? "DEPOSIT" : "WITHDRAWAL",
      rawMemo: "CITI CARD ONLINEPAYMENT",
      normalizedMerchant: "citi card onlinepayment",
      amountCents,
      importSource: "simplefin",
      importBatchId: batch.id,
      importRowHash: `seed-candidate-${seq}`,
      transferPairId,
    })
    .returning()
    .all();
  return row;
}

describe("loadCardPaymentCandidates (T9)", () => {
  it("returns an unpaired positive row on the card", () => {
    const citi = seedAccount("Citi");
    const row = seedRow(citi.id, "2026-09-13", 50_000);

    expect(loadCardPaymentCandidates(citi.id, handle.db)).toEqual([
      { id: row.id, date: row.date, amountCents: 50_000, rawMemo: row.rawMemo },
    ]);
  });

  it("excludes a negative row — a candidate must be a CREDIT to the card", () => {
    const citi = seedAccount("Citi");
    seedRow(citi.id, "2026-09-13", -8_000); // an ordinary charge, not a payment
    expect(loadCardPaymentCandidates(citi.id, handle.db)).toEqual([]);
  });

  it("excludes an already-paired row — linkTransferPairManually would refuse it anyway", () => {
    const citi = seedAccount("Citi");
    const other = seedAccount("Checking", "checking");
    const partner = seedRow(other.id, "2026-09-10", -50_000);
    const row = seedRow(citi.id, "2026-09-13", 50_000, partner.id);
    // Wire the partner side too, matching a real pair.
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: row.id })
      .where(eq(schema.transactions.id, partner.id))
      .run();

    expect(loadCardPaymentCandidates(citi.id, handle.db)).toEqual([]);
  });

  it("excludes rows on a DIFFERENT account", () => {
    const citi = seedAccount("Citi");
    const amex = seedAccount("Amex");
    seedRow(amex.id, "2026-09-13", 50_000);
    expect(loadCardPaymentCandidates(citi.id, handle.db)).toEqual([]);
  });

  it("sorts newest first", () => {
    const citi = seedAccount("Citi");
    const older = seedRow(citi.id, "2026-06-13", 20_000);
    const newer = seedRow(citi.id, "2026-09-13", 20_000);
    expect(loadCardPaymentCandidates(citi.id, handle.db).map((c) => c.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });
});
