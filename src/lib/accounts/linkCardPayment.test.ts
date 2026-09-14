import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadAccountBalances } from "./loadAccountBalances";
import { linkCardPayment } from "./linkCardPayment";

let handle: TestDbHandle;
let seq = 0;

beforeEach(() => {
  handle = createTestDb();
  seq = 0;
});
afterEach(() => handle.close());

function seedAccount(opts: {
  name: string;
  type: "checking" | "credit" | "loan";
  cents?: number;
  anchor?: string;
  simplefinAccountId?: string;
}) {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: opts.name,
      type: opts.type,
      startingBalanceCents: opts.cents ?? (opts.type === "checking" ? 500_000 : -200_000),
      startingBalanceDate: opts.anchor ?? "2026-08-01",
      simplefinAccountId: opts.simplefinAccountId ?? null,
    })
    .returning()
    .all();
  return row;
}

function seedCategory(name = "Groceries") {
  const existing = handle.db
    .select()
    .from(schema.categories)
    .where(eq(schema.categories.name, name))
    .get();
  return existing!;
}

function seedRow(opts: {
  accountId: number;
  date: string;
  amountCents: number;
  categoryId?: number | null;
  importSource?: "csv" | "simplefin" | "manual";
}) {
  seq += 1;
  const [batch] = handle.db
    .insert(schema.importBatches)
    .values({ source: opts.importSource ?? "csv", label: `seed.${seq}` })
    .returning()
    .all();
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId: opts.accountId,
      date: opts.date,
      rawDescription: "WITHDRAWAL",
      rawMemo: "CITI CARD ONLINEPAYMENT",
      normalizedMerchant: "citi card onlinepayment",
      amountCents: opts.amountCents,
      importSource: opts.importSource ?? "csv",
      importBatchId: batch.id,
      importRowHash: `seed-link-${seq}`,
      categoryId: opts.categoryId ?? null,
    })
    .returning()
    .all();
  return row;
}

const balanceOf = (id: number) => loadAccountBalances(handle.db).find((b) => b.id === id)!.balanceCents;

describe("linkCardPayment (T9)", () => {
  it("links a checking payment to the real card row, cross-account and cross-date (D8.2)", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    // Offsets of a few days, matching the measured real-world pattern D8.2
    // cites — the whole point is that this is NOT same-day.
    const payment = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: -50_000 });
    const cardRow = seedRow({
      accountId: citi.id,
      date: "2026-09-13",
      amountCents: 50_000,
      importSource: "simplefin",
    });

    const result = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: cardRow.id },
      handle.db,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.message).toContain("Linked to Citi");
    }

    const legs = handle.db.select().from(schema.transactions).all();
    const checkingLeg = legs.find((r) => r.id === payment.id)!;
    const citiLeg = legs.find((r) => r.id === cardRow.id)!;
    expect(checkingLeg.transferPairId).toBe(citiLeg.id);
    expect(citiLeg.transferPairId).toBe(checkingLeg.id);
    expect(balanceOf(citi.id)).toBe(-150_000);
  });

  it("warns, but does not refuse, when the source leg was already categorized (D4.1)", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    const payment = seedRow({
      accountId: checking.id,
      date: "2026-09-10",
      amountCents: -50_000,
      categoryId: seedCategory().id,
    });
    const cardRow = seedRow({
      accountId: citi.id,
      date: "2026-09-13",
      amountCents: 50_000,
      importSource: "simplefin",
    });

    const result = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: cardRow.id },
      handle.db,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.message).toContain("already filed under a category");
    }
  });

  it("does not warn when the source leg is uncategorized", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    const payment = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: -50_000 });
    const cardRow = seedRow({
      accountId: citi.id,
      date: "2026-09-13",
      amountCents: 50_000,
      importSource: "simplefin",
    });

    const result = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: cardRow.id },
      handle.db,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.message).not.toContain("already filed under a category");
    }
  });

  it("refuses when the target account does not import its own transactions", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    // No simplefinAccountId — an ordinary, non-importing card.
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const payment = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: -50_000 });
    const cardRow = seedRow({ accountId: visa.id, date: "2026-09-13", amountCents: 50_000 });

    const result = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: cardRow.id },
      handle.db,
    );

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("not-importing");
      expect(result.message).toContain("Mark as payment to");
    }
  });

  it("refuses a missing source transaction", () => {
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    const cardRow = seedRow({ accountId: citi.id, date: "2026-09-13", amountCents: 50_000 });

    const result = linkCardPayment({ transactionId: 999_999, cardTransactionId: cardRow.id }, handle.db);
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toBe("not-found");
  });

  it("propagates linkTransferPairManually's own refusal (e.g. already paired) as a refusal, not a throw", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    const payment = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: -50_000 });
    const cardRow = seedRow({
      accountId: citi.id,
      date: "2026-09-13",
      amountCents: 50_000,
      importSource: "simplefin",
    });
    const otherCardRow = seedRow({
      accountId: citi.id,
      date: "2026-09-14",
      amountCents: 50_000,
      importSource: "simplefin",
    });

    const first = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: cardRow.id },
      handle.db,
    );
    expect(first.status).toBe("ok");

    const second = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: otherCardRow.id },
      handle.db,
    );
    expect(second.status).toBe("refused");
  });

  it("refuses when the card transaction id does not exist", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const payment = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: -50_000 });

    const result = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: 999_999 },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("not-found");
      expect(result.message).toContain("card transaction no longer exists");
    }
  });

  it("refuses when the source row's amount is not negative — a payment has to be money leaving an account", () => {
    // Red-team finding: the row menu's candidate filter is magnitude-only, so
    // without this guard a POSITIVE row (a deposit) could still find a
    // matching-magnitude card charge and link to it.
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    const deposit = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: 50_000 });
    const cardCharge = seedRow({
      accountId: citi.id,
      date: "2026-09-13",
      amountCents: -50_000,
      importSource: "simplefin",
    });

    const result = linkCardPayment(
      { transactionId: deposit.id, cardTransactionId: cardCharge.id },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.message).toBe("A card payment has to be money leaving an account.");
    }
  });

  it("refuses when the source row lives on a NON-ASSET account — a card's own charge cannot be a payment (red-team finding)", () => {
    // markAsCardPayment already guards this exact invariant on its own write
    // path (a Visa charge marked as a Mastercard payment once inflated
    // paidDownCents for money that was never paid) — this pins the identical
    // guard on linkCardPayment. Reachable through ordinary use: the row menu
    // offers "Link to a card charge" on any negative row regardless of which
    // account it lives on, filtered only by magnitude.
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    const visaCharge = seedRow({ accountId: visa.id, date: "2026-09-10", amountCents: -50_000 });
    const citiCredit = seedRow({
      accountId: citi.id,
      date: "2026-09-13",
      amountCents: 50_000,
      importSource: "simplefin",
    });

    const result = linkCardPayment(
      { transactionId: visaCharge.id, cardTransactionId: citiCredit.id },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.message).toBe(
        "A payment has to come from a checking or savings account, not from Visa.",
      );
    }
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
  });

  it("refuses when the target row's account is not a credit card at all", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const otherChecking = seedAccount({ name: "Savings", type: "checking" });
    const payment = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: -50_000 });
    // A row on an ordinary asset account — not a card, so `!isCreditCard`
    // fires before the `!importsTransactions` branch ever gets a look.
    const nonCardRow = seedRow({ accountId: otherChecking.id, date: "2026-09-13", amountCents: 50_000 });

    const result = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: nonCardRow.id },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("not-a-card");
      expect(result.message).toBe("That row is not on a credit card.");
    }
  });

  it("refuses when the target row's own import_source is manual, even if a caller bypasses the picker (Codex structured review)", () => {
    // `loadCardPaymentCandidates` already excludes manual rows from the
    // picker, but a Server Action is a network endpoint regardless of what
    // rendered it — re-checked here rather than trusted from the client.
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    const payment = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: -50_000 });
    const manualRefund = seedRow({
      accountId: citi.id,
      date: "2026-09-13",
      amountCents: 50_000,
      importSource: "manual",
      categoryId: seedCategory().id,
    });

    const result = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: manualRefund.id },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.message).toContain("entered by hand");
    }
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId === null)).toBe(true);
  });

  it("reports a cleared rejection when the pair had a prior 'not a transfer' marker", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const citi = seedAccount({ name: "Citi", type: "credit", simplefinAccountId: "ACT-citi" });
    const payment = seedRow({ accountId: checking.id, date: "2026-09-10", amountCents: -50_000 });
    const cardRow = seedRow({
      accountId: citi.id,
      date: "2026-09-13",
      amountCents: 50_000,
      importSource: "simplefin",
    });
    // Simulate a prior "Not a transfer" rejection recorded against this exact
    // pair (e.g. the automatic matcher offered it and the user declined).
    handle.db
      .insert(schema.transferPairRejections)
      .values({
        lowTransactionId: Math.min(payment.id, cardRow.id),
        highTransactionId: Math.max(payment.id, cardRow.id),
      })
      .run();

    const result = linkCardPayment(
      { transactionId: payment.id, cardTransactionId: cardRow.id },
      handle.db,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.message).toContain("cleared the “not a transfer”");
    }
  });
});
