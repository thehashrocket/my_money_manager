import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadAccountBalances } from "./loadAccountBalances";
import {
  createCardActivity,
  markAsCardPayment,
  unmarkCardPayment,
} from "./manualTransaction";

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
}) {
  const [row] = handle.db
    .insert(schema.accounts)
    .values({
      name: opts.name,
      type: opts.type,
      startingBalanceCents: opts.cents ?? (opts.type === "checking" ? 500_000 : -200_000),
      startingBalanceDate: opts.anchor ?? "2026-08-01",
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

function seedCheckingDebit(accountId: number, date: string, amountCents: number) {
  seq += 1;
  const [batch] = handle.db
    .insert(schema.importBatches)
    .values({ source: "csv", label: "seed.csv" })
    .returning()
    .all();
  const [row] = handle.db
    .insert(schema.transactions)
    .values({
      accountId,
      date,
      rawDescription: "WITHDRAWAL",
      rawMemo: "PAYMENT",
      normalizedMerchant: "payment",
      amountCents,
      importSource: "csv",
      importBatchId: batch.id,
      importRowHash: `seed-${seq}`,
    })
    .returning()
    .all();
  return row;
}

const balanceOf = (id: number) =>
  loadAccountBalances(handle.db).find((b) => b.id === id)!.balanceCents;

describe("createCardActivity — charges", () => {
  it("writes a negative row and moves the balance", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const result = createCardActivity(
      {
        kind: "charge",
        accountId: visa.id,
        date: "2026-09-03",
        amountCents: 8_000,
        merchant: "COSTCO WHSE",
        categoryId: seedCategory().id,
      },
      handle.db,
    );

    expect(result.status).toBe("ok");
    expect(balanceOf(visa.id)).toBe(-208_000);
    const row = handle.db.select().from(schema.transactions).get();
    expect(row?.amountCents).toBe(-8_000);
    expect(row?.importSource).toBe("manual");
    expect(row?.categoryId).toBe(seedCategory().id);
  });

  it("REFUSES a charge dated on or before the anchor (D12 / F2)", () => {
    // Rule 1's `>` is strict, so this row would land in /transactions and in
    // its budget envelope while contributing NOTHING to the card balance —
    // it would count as spend and not move the balance, which is
    // inconsistent. Refuse rather than warn.
    const visa = seedAccount({ name: "Visa", type: "credit", anchor: "2026-09-20" });
    const result = createCardActivity(
      {
        kind: "charge",
        accountId: visa.id,
        date: "2026-09-03",
        amountCents: 8_000,
        merchant: "COSTCO",
        categoryId: seedCategory().id,
      },
      handle.db,
    );

    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("before-anchor");
      // DS56 needs the account id to open the right row's reconcile form.
      expect(result.accountId).toBe(visa.id);
      expect(result.message).toContain("wouldn't count toward the balance");
    }
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("REFUSES a charge dated exactly ON the anchor — the boundary", () => {
    const visa = seedAccount({ name: "Visa", type: "credit", anchor: "2026-09-20" });
    const result = createCardActivity(
      {
        kind: "charge",
        accountId: visa.id,
        date: "2026-09-20",
        amountCents: 8_000,
        merchant: "COSTCO",
        categoryId: seedCategory().id,
      },
      handle.db,
    );
    expect(result.status).toBe("refused");
  });

  it("rejects a non-positive amount and an empty merchant", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const base = {
      kind: "charge" as const,
      accountId: visa.id,
      date: "2026-09-03",
      amountCents: 8_000,
      merchant: "COSTCO",
      categoryId: seedCategory().id,
    };
    expect(createCardActivity({ ...base, amountCents: 0 }, handle.db).status).toBe("refused");
    expect(createCardActivity({ ...base, amountCents: -1 }, handle.db).status).toBe("refused");
    expect(createCardActivity({ ...base, merchant: "   " }, handle.db).status).toBe("refused");
  });
});

describe("createCardActivity — refunds (E13)", () => {
  it("writes a POSITIVE row for a return", () => {
    // Without this a $200 Costco return has nowhere to go and the Groceries
    // envelope keeps money you got back.
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const result = createCardActivity(
      {
        kind: "refund",
        accountId: visa.id,
        date: "2026-09-12",
        amountCents: 20_000,
        merchant: "COSTCO WHSE",
        categoryId: seedCategory().id,
      },
      handle.db,
    );

    expect(result.status).toBe("ok");
    const row = handle.db.select().from(schema.transactions).get();
    expect(row?.amountCents).toBe(20_000);
    // Still categorized: spentCents = 0 - SUM(amount_cents), so a positive
    // card row reduces envelope spend, which is the whole point.
    expect(row?.categoryId).toBe(seedCategory().id);
    expect(balanceOf(visa.id)).toBe(-180_000);
  });

  it("REFUSES a pre-anchor refund for the same reason as a charge", () => {
    const visa = seedAccount({ name: "Visa", type: "credit", anchor: "2026-09-20" });
    const result = createCardActivity(
      {
        kind: "refund",
        accountId: visa.id,
        date: "2026-09-03",
        amountCents: 20_000,
        merchant: "COSTCO",
        categoryId: seedCategory().id,
      },
      handle.db,
    );
    expect(result.status).toBe("refused");
  });
});

describe("E17 — the mortgage is not a valid target for any manual write", () => {
  it("REJECTS a charge on a loan (F14)", () => {
    // E1 closed the sync door and E6 closed the CSV door; this was the third.
    // The zero-transaction-row premise is load-bearing under D3, D7, D15 and
    // E16, and was guaranteed by nothing but button placement.
    const mortgage = seedAccount({ name: "Mortgage", type: "loan" });
    const result = createCardActivity(
      {
        kind: "charge",
        accountId: mortgage.id,
        date: "2026-09-03",
        amountCents: 8_000,
        merchant: "ESCROW",
        categoryId: seedCategory().id,
      },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toBe("not-a-card");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("REJECTS a payment targeting a loan", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const mortgage = seedAccount({ name: "Mortgage", type: "loan" });
    const leg = seedCheckingDebit(checking.id, "2026-09-15", -185_000);

    const result = markAsCardPayment(
      { transactionId: leg.id, cardAccountId: mortgage.id },
      handle.db,
    );
    expect(result.status).toBe("refused");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(1);
  });

  it("REJECTS a payment targeting a checking account", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const other = seedAccount({ name: "Other", type: "checking" });
    const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);
    expect(
      markAsCardPayment({ transactionId: leg.id, cardAccountId: other.id }, handle.db).status,
    ).toBe("refused");
  });
});

describe("markAsCardPayment", () => {
  it("mirrors the debit onto the card and links both legs", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);

    const result = markAsCardPayment(
      { transactionId: leg.id, cardAccountId: visa.id },
      handle.db,
    );

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.message).toContain("payment to Visa");
      expect(result.balanceCents).toBe(-150_000);
    }

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(2);
    const mirror = rows.find((r) => r.accountId === visa.id)!;
    const checkingLeg = rows.find((r) => r.accountId === checking.id)!;
    expect(mirror.amountCents).toBe(50_000);
    expect(mirror.categoryId).toBeNull();
    expect(mirror.importSource).toBe("manual");
    // Symmetric, so every `transfer_pair_id IS NULL` filter excludes both.
    expect(checkingLeg.transferPairId).toBe(mirror.id);
    expect(mirror.transferPairId).toBe(checkingLeg.id);
  });

  it("ACCEPTS a payment dated before the card's anchor (E5 / F11)", () => {
    // The anchor defaults to today at account creation, so D12-as-written
    // would have failed this for 100% of existing history on day one — and
    // each refusal left the checking leg unpaired, so the payment kept
    // counting as spend. A payment must not count as spend and contributes
    // nothing new to the balance, because an anchor dated after it already
    // includes it.
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const visa = seedAccount({ name: "Visa", type: "credit", anchor: "2026-09-20" });
    const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);

    const result = markAsCardPayment(
      { transactionId: leg.id, cardAccountId: visa.id },
      handle.db,
    );
    expect(result.status).toBe("ok");

    // The balance is unmoved, and that is CORRECT: the anchor already
    // includes this payment.
    expect(balanceOf(visa.id)).toBe(-200_000);
    const checkingLeg = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, leg.id))
      .get();
    expect(checkingLeg?.transferPairId).not.toBeNull();
  });

  it("refuses a positive row — a payment is money leaving an account", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const deposit = seedCheckingDebit(checking.id, "2026-09-15", 50_000);
    expect(
      markAsCardPayment({ transactionId: deposit.id, cardAccountId: visa.id }, handle.db).status,
    ).toBe("refused");
  });

  describe("E10 — three-way idempotency, re-read inside the write transaction", () => {
    it("branch 1: unpaired → proceeds", () => {
      const checking = seedAccount({ name: "Checking", type: "checking" });
      const visa = seedAccount({ name: "Visa", type: "credit" });
      const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);
      expect(
        markAsCardPayment({ transactionId: leg.id, cardAccountId: visa.id }, handle.db).status,
      ).toBe("ok");
    });

    it("branch 2: already paired to THIS card → no-op, reports SUCCESS (F5)", () => {
      // A double-submit must not create a second mirror.
      const checking = seedAccount({ name: "Checking", type: "checking" });
      const visa = seedAccount({ name: "Visa", type: "credit" });
      const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);

      markAsCardPayment({ transactionId: leg.id, cardAccountId: visa.id }, handle.db);
      const second = markAsCardPayment(
        { transactionId: leg.id, cardAccountId: visa.id },
        handle.db,
      );

      expect(second.status).toBe("ok");
      expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
      expect(balanceOf(visa.id)).toBe(-150_000);
    });

    it("branch 3: paired to something ELSE → REFUSES and names the partner", () => {
      // Guarding on `transfer_pair_id IS NOT NULL` alone would silently
      // succeed here, reporting a payment to this card that does not exist —
      // rule 4 auto-links balanced buckets without asking.
      const checking = seedAccount({ name: "Checking", type: "checking" });
      const savings = seedAccount({ name: "Savings", type: "checking" });
      const visa = seedAccount({ name: "Visa", type: "credit" });
      const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);
      const other = seedCheckingDebit(savings.id, "2026-09-15", 50_000);

      handle.db
        .update(schema.transactions)
        .set({ transferPairId: other.id })
        .where(eq(schema.transactions.id, leg.id))
        .run();

      const result = markAsCardPayment(
        { transactionId: leg.id, cardAccountId: visa.id },
        handle.db,
      );
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.reason).toBe("already-paired");
        expect(result.message).toContain("Savings");
      }
    });
  });
});

describe("unmarkCardPayment (E12 / F15)", () => {
  it("DELETES the mirror rather than stranding it", () => {
    // unlinkTransferPair was built for two real bank rows. Applied here it
    // leaves a category-NULL, pair-NULL row that the Spine's backlog query
    // counts, still inflates the card balance, has no correct category, and
    // is rejection-marked against the checking row so re-pairing is blocked.
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);
    markAsCardPayment({ transactionId: leg.id, cardAccountId: visa.id }, handle.db);

    const result = unmarkCardPayment({ transactionId: leg.id }, handle.db);
    expect(result.status).toBe("ok");

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBe(checking.id);
    expect(rows[0].transferPairId).toBeNull();
    // The balance is back where it started — no orphan inflating it.
    expect(balanceOf(visa.id)).toBe(-200_000);
  });

  it("writes NO rejection marker, so the row can be re-marked", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);

    markAsCardPayment({ transactionId: leg.id, cardAccountId: visa.id }, handle.db);
    unmarkCardPayment({ transactionId: leg.id }, handle.db);

    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, leg.id))
      .get();
    expect(after?.transferRejectedPartnerId).toBeNull();

    // Re-markable, including to a different card.
    const amex = seedAccount({ name: "Amex", type: "credit" });
    expect(
      markAsCardPayment({ transactionId: leg.id, cardAccountId: amex.id }, handle.db).status,
    ).toBe("ok");
  });

  it("removes the mirror's own batch, which existed only to carry it (E21)", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);
    markAsCardPayment({ transactionId: leg.id, cardAccountId: visa.id }, handle.db);
    expect(
      handle.db.select().from(schema.importBatches).all().filter((b) => b.source === "manual"),
    ).toHaveLength(1);

    unmarkCardPayment({ transactionId: leg.id }, handle.db);
    expect(
      handle.db.select().from(schema.importBatches).all().filter((b) => b.source === "manual"),
    ).toHaveLength(0);
  });

  it("REFUSES to delete a pair it did not create — two real bank rows", () => {
    // Deleting one of those would destroy imported history. That case belongs
    // to unlinkTransferPair, which keeps both rows.
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const savings = seedAccount({ name: "Savings", type: "checking" });
    const a = seedCheckingDebit(checking.id, "2026-09-15", -50_000);
    const b = seedCheckingDebit(savings.id, "2026-09-15", 50_000);
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: b.id })
      .where(eq(schema.transactions.id, a.id))
      .run();
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: a.id })
      .where(eq(schema.transactions.id, b.id))
      .run();

    const result = unmarkCardPayment({ transactionId: a.id }, handle.db);
    expect(result.status).toBe("refused");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
  });

  it("is a no-op on an unpaired row", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const leg = seedCheckingDebit(checking.id, "2026-09-15", -50_000);
    expect(unmarkCardPayment({ transactionId: leg.id }, handle.db).status).toBe("ok");
  });
});

describe("E21 — one import batch per manual operation", () => {
  it("gives two charges two batches, each with transaction_count 1", () => {
    // Reusing one batch forever would freeze imported_at, need a
    // read-modify-write increment on a count nobody reads, and permanently
    // falsify snapshot_path, snapshot_warning and both anchor column pairs.
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const base = {
      kind: "charge" as const,
      accountId: visa.id,
      amountCents: 8_000,
      merchant: "COSTCO",
      categoryId: seedCategory().id,
    };
    createCardActivity({ ...base, date: "2026-09-03" }, handle.db);
    createCardActivity({ ...base, date: "2026-09-04" }, handle.db);

    const batches = handle.db
      .select()
      .from(schema.importBatches)
      .all()
      .filter((b) => b.source === "manual");
    expect(batches).toHaveLength(2);
    for (const b of batches) expect(b.transactionCount).toBe(1);
    // Distinct timestamps are the point; distinct ids are the proof.
    expect(new Set(batches.map((b) => b.id)).size).toBe(2);
  });

  it("keeps each row's dedup hash distinct within its own batch", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const base = {
      kind: "charge" as const,
      accountId: visa.id,
      date: "2026-09-03",
      amountCents: 8_000,
      merchant: "COSTCO",
      categoryId: seedCategory().id,
    };
    // Two IDENTICAL charges on the same day — two real coffees. Both survive.
    expect(createCardActivity(base, handle.db).status).toBe("ok");
    expect(createCardActivity(base, handle.db).status).toBe("ok");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(2);
  });
});
