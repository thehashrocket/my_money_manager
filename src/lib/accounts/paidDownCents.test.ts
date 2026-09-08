import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { paidDownCents } from "./paidDownCents";

let handle: TestDbHandle;
let seq = 0;

beforeEach(() => {
  handle = createTestDb();
  seq = 0;
});
afterEach(() => handle.close());

function seedAccount(name: string, type: "credit" | "loan" | "checking" = "credit") {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name,
      type,
      startingBalanceCents: type === "checking" ? 100_000 : -200_000,
      startingBalanceDate: "2026-08-01",
    })
    .returning()
    .all();
  return row;
}

function seedBatchId(): number {
  const [row] = handle.db
    .insert(schema.importBatches)
    .values({ source: "manual", transactionCount: 1 })
    .returning()
    .all();
  return row.id;
}

function seedTxn(opts: { accountId: number; date: string; amountCents: number }) {
  seq += 1;
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: opts.amountCents < 0 ? "PURCHASE" : "DEPOSIT",
      rawMemo: "MEMO",
      normalizedMerchant: "MERCHANT",
      amountCents: opts.amountCents,
      importSource: "manual",
      importBatchId: seedBatchId(),
      importRowHash: `hash-${seq}`,
    })
    .returning()
    .all();
  return row;
}

/** The symmetric two-way link `markAsCardPayment` writes. */
function link(a: number, b: number) {
  handle.db
    .update(schema.transactions)
    .set({ transferPairId: b })
    .where(eq(schema.transactions.id, a))
    .run();
  handle.db
    .update(schema.transactions)
    .set({ transferPairId: a })
    .where(eq(schema.transactions.id, b))
    .run();
}

/** A card payment as D10 path 1 records it: +cents on the card, -cents on
 *  checking, the two rows paired. */
function seedPayment(cardId: number, checkingId: number, date: string, cents: number) {
  const mirror = seedTxn({ accountId: cardId, date, amountCents: cents });
  const leg = seedTxn({ accountId: checkingId, date, amountCents: -cents });
  link(mirror.id, leg.id);
}

describe("paidDownCents", () => {
  it("returns null — not 0 — for an account with no rows at all", () => {
    // The mortgage under D3=A. A $0.00 here would be a false statement about
    // a real account, so the row omits the line rather than printing one.
    const mortgage = seedAccount("Mortgage", "loan");
    expect(paidDownCents(mortgage.id, 2026, 9, handle.db)).toBeNull();
  });

  it("sums paired positive rows inside the month", () => {
    const visa = seedAccount("Visa");
    const checking = seedAccount("Checking", "checking");
    seedPayment(visa.id, checking.id, "2026-09-10", 50_000);

    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(50_000);
  });

  it("EXCLUDES a positive paired to a row on the SAME account — a reversal, not a payment", () => {
    // The regression this closes, found by adversarial review during /ship
    // 2026-09-08 and measured going $0.00 -> $200.00.
    //
    // E13 narrowed the predicate to "paired positives" on the reasoning that
    // the cross-account payment mirror was the only positive a card could ever
    // have paired. Same-account reversal linking broke that premise: a disputed
    // charge and its provisional credit sit on ONE card, and pairing them makes
    // the credit a paired positive. Nothing left checking, so nothing was paid
    // down — but the figure would read like a $200 payment.
    const visa = seedAccount("Visa");
    const credit = seedTxn({ accountId: visa.id, date: "2026-09-12", amountCents: 20_000 });
    const charge = seedTxn({ accountId: visa.id, date: "2026-09-12", amountCents: -20_000 });
    link(credit.id, charge.id);

    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(0);
  });

  it("still counts a real payment when the card ALSO has a same-account reversal that month", () => {
    // The exclusion must be per-row, not a whole-account disqualifier.
    const visa = seedAccount("Visa");
    const checking = seedAccount("Checking", "checking");
    seedPayment(visa.id, checking.id, "2026-09-10", 50_000);
    const credit = seedTxn({ accountId: visa.id, date: "2026-09-12", amountCents: 20_000 });
    const charge = seedTxn({ accountId: visa.id, date: "2026-09-12", amountCents: -20_000 });
    link(credit.id, charge.id);

    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(50_000);
  });

  it("EXCLUDES an unpaired positive row — that is a refund, not a payment (E13)", () => {
    // The bug this closes: `SUM(amount_cents > 0)` was correct only because
    // the payment mirror used to be the sole positive row a card could own.
    // A $200 Costco return would otherwise count as debt you paid off, using
    // money that never left your checking account.
    const visa = seedAccount("Visa");
    seedTxn({ accountId: visa.id, date: "2026-09-12", amountCents: 20_000 });

    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(0);
  });

  it("counts the payment but not the refund when a month holds both", () => {
    const visa = seedAccount("Visa");
    const checking = seedAccount("Checking", "checking");
    seedPayment(visa.id, checking.id, "2026-09-10", 50_000);
    seedTxn({ accountId: visa.id, date: "2026-09-12", amountCents: 20_000 });

    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(50_000);
  });

  it("ignores charges", () => {
    const visa = seedAccount("Visa");
    seedTxn({ accountId: visa.id, date: "2026-09-05", amountCents: -8_000 });
    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(0);
  });

  it("returns 0 for a month with no payments, so the caller can omit the line", () => {
    const visa = seedAccount("Visa");
    const checking = seedAccount("Checking", "checking");
    seedPayment(visa.id, checking.id, "2026-08-10", 50_000);

    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(0);
  });

  it("respects both month boundaries, including the last day of a 30-day month", () => {
    const visa = seedAccount("Visa");
    const checking = seedAccount("Checking", "checking");
    for (const date of ["2026-08-31", "2026-09-01", "2026-09-30", "2026-10-01"]) {
      seedPayment(visa.id, checking.id, date, 10_000);
    }
    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(20_000);
  });

  it("is scoped to one account", () => {
    const visa = seedAccount("Visa");
    const amex = seedAccount("Amex");
    const checking = seedAccount("Checking", "checking");
    seedPayment(visa.id, checking.id, "2026-09-10", 50_000);
    seedPayment(amex.id, checking.id, "2026-09-11", 30_000);

    expect(paidDownCents(visa.id, 2026, 9, handle.db)).toBe(50_000);
    expect(paidDownCents(amex.id, 2026, 9, handle.db)).toBe(30_000);
  });
});
