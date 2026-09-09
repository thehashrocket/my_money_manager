import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { loadAccountBalances } from "./loadAccountBalances";
import {
  createCardActivity,
  markAsCardPayment,
  removeCardActivity,
  unmarkCardPayment,
} from "./manualTransaction";
import { hasAnyTransactionRows } from "./hasAnyTransactionRows";
import { resolveBalanceAction } from "./resolveBalanceAction";

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
      // A human date, not a raw ISO string, inside a user-facing sentence.
      expect(result.message).toContain("Sep 20");
      expect(result.message).not.toContain("2026-09-20");
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
    expect(after).toBeDefined();
    // Unmarking is not a rejection: nothing should have been recorded against
    // this row, or the automatic matchers would be blocked from re-pairing it.
    expect(handle.db.select().from(schema.transferPairRejections).all()).toEqual([]);

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

/**
 * The `not-found` and "already on this card" refusals. Every one is reachable
 * from a stale tab — a Server Action is a network endpoint regardless of what
 * the UI rendered — and none of them may throw (E20), because a throw
 * unmounts /accounts and takes the user's typed input with it.
 */
describe("refusals reachable from a stale tab", () => {
  it("refuses a charge against an account id that no longer exists", () => {
    const category = seedCategory();
    const result = createCardActivity(
      {
        kind: "charge",
        accountId: 999_999,
        date: "2026-09-06",
        amountCents: 8_000,
        merchant: "Costco",
        categoryId: category.id,
      },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toBe("not-found");
  });

  it("refuses a payment whose checking leg no longer exists", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const result = markAsCardPayment(
      { transactionId: 999_999, cardAccountId: visa.id },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") expect(result.reason).toBe("not-found");
  });

  it("refuses to mark a row on the card as a payment TO that same card", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const onCard = seedCheckingDebit(visa.id, "2026-09-06", -25_000);
    const result = markAsCardPayment(
      { transactionId: onCard.id, cardAccountId: visa.id },
      handle.db,
    );
    expect(result.status).toBe("refused");
    if (result.status === "refused") {
      expect(result.reason).toBe("invalid");
      expect(result.message).toContain("Visa");
    }
    // No mirror was written, so the card's balance is untouched.
    expect(balanceOf(visa.id)).toBe(-200_000 - 25_000);
  });
});

describe("createCardActivity — date validation", () => {
  // REGRESSION. The anchor guard below this check is `input.date <=
  // account.startingBalanceDate` — a LEXICOGRAPHIC compare against a TEXT
  // column. Any string sorting after the anchor passed it and was inserted
  // verbatim, so "2026-13-40" and "banana" both returned status "ok" and
  // landed in transactions.date. Rule 1's strict `>` then mis-sorts the
  // account's whole history against a date that is not a date. CLAUDE.md
  // hardened the CSV path against exactly this in v0.12.4; this is the same
  // check on the third write path.
  it.each(["2026-13-40", "2026-02-30", "banana", "", "04/31/2026"])(
    "REFUSES the calendar-invalid or malformed date %j instead of storing it",
    (bad) => {
      const visa = seedAccount({ name: "Visa", type: "credit", anchor: "2026-08-01" });
      const result = createCardActivity(
        {
          kind: "charge",
          accountId: visa.id,
          date: bad,
          amountCents: 5_000,
          merchant: "COSTCO WHSE",
          categoryId: seedCategory().id,
        },
        handle.db,
      );

      expect(result.status).toBe("refused");
      expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
    },
  );

  it("still accepts a well-formed date after the anchor", () => {
    const visa = seedAccount({ name: "Visa", type: "credit", anchor: "2026-08-01" });
    const result = createCardActivity(
      {
        kind: "charge",
        accountId: visa.id,
        date: "2026-08-15",
        amountCents: 5_000,
        merchant: "COSTCO WHSE",
        categoryId: seedCategory().id,
      },
      handle.db,
    );

    expect(result.status).toBe("ok");
  });
});

/** A category not present in the migration seed, for the cases that need one. */
function insertCategory(opts: {
  name: string;
  kind: "income" | "expense" | "fund";
  parentId?: number | null;
  archived?: boolean;
}) {
  const [row] = handle.db
    .insert(schema.categories)
    .values({
      name: opts.name,
      kind: opts.kind,
      parentId: opts.parentId ?? null,
      isSavingsGoal: opts.kind === "fund",
      archivedAt: opts.archived ? new Date() : null,
    })
    .returning()
    .all();
  return row;
}

const chargeWith = (accountId: number, categoryId: number) =>
  createCardActivity(
    {
      kind: "charge",
      accountId,
      date: "2026-09-03",
      amountCents: 8_000,
      merchant: "COSTCO WHSE",
      categoryId,
    },
    handle.db,
  );

/**
 * The category was accepted on trust: the action checked
 * `Number.isInteger(id) && id > 0` and `createCardActivity` inserted it
 * verbatim. `categorizeTransaction` and `bulkCategorize` both classify the
 * category first; this path skipped that entirely.
 */
describe("createCardActivity — the category has to be one you can charge to", () => {
  it("REFUSES an income category — the case that needed no adversary", () => {
    // "Paycheck" is a migration-seeded income leaf, and income leaves were in
    // the charge dialog's own picker. Filing an $80 charge here wrote -8000
    // into income and silently reduced that month's leftToBudgetCents.
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const paycheck = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Paycheck"))
      .get()!;
    expect(paycheck.kind).toBe("income");

    const result = chargeWith(visa.id, paycheck.id);

    expect(result.status).toBe("refused");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
    expect(balanceOf(visa.id)).toBe(-200_000);
  });

  it("refuses a parent category — spend there belongs to no envelope", () => {
    // "Food" is a header. loadMonthView renders it as a section heading, so a
    // charge filed under it exists in the ledger and is invisible in the
    // budget — the outcome D13=B exists to prevent.
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const food = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Food"))
      .get()!;

    const result = chargeWith(visa.id, food.id);

    expect(result.status).toBe("refused");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("refuses an archived category (rule 8 hides it from every picker)", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const gone = insertCategory({ name: "Old Hobby", kind: "expense", archived: true });

    const result = chargeWith(visa.id, gone.id);

    expect(result.status).toBe("refused");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("refuses a savings-goal (fund) category", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const fund = insertCategory({ name: "Emergency Fund", kind: "fund" });

    const result = chargeWith(visa.id, fund.id);

    expect(result.status).toBe("refused");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("refuses an id that matches no category, as state rather than a raw FK error", () => {
    // The FK would fire anyway, but as "FOREIGN KEY constraint failed" thrown
    // out of db.transaction — which breaks the module's own contract that
    // nothing throws for a reachable outcome (E20).
    const visa = seedAccount({ name: "Visa", type: "credit" });

    const result = chargeWith(visa.id, 999_999);

    expect(result.status).toBe("refused");
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("still accepts an ordinary expense leaf", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const result = chargeWith(visa.id, seedCategory().id);
    expect(result.status).toBe("ok");
    expect(balanceOf(visa.id)).toBe(-208_000);
  });
});

/**
 * The target of a payment was guarded by `requireCardAccount`; the SOURCE leg
 * was only checked for "not this account" and "is negative" — which every
 * charge on a DIFFERENT card also satisfies.
 */
describe("markAsCardPayment — the money has to come from an asset", () => {
  it("REFUSES a leg that lives on another credit card", () => {
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const mastercard = seedAccount({ name: "Mastercard", type: "credit" });
    const charge = chargeWith(visa.id, seedCategory().id);
    expect(charge.status).toBe("ok");
    const visaCharge = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, visa.id))
      .get()!;

    const result = markAsCardPayment(
      { transactionId: visaCharge.id, cardAccountId: mastercard.id },
      handle.db,
    );

    expect(result.status).toBe("refused");
    // No mirror minted on the Mastercard...
    expect(
      handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.accountId, mastercard.id))
        .all(),
    ).toHaveLength(0);
    expect(balanceOf(mastercard.id)).toBe(-200_000);
    // ...and the real Visa charge is still unpaired, so it still counts as
    // spending. Pairing it would have dropped it out of every
    // `transfer_pair_id IS NULL` sum and out of its envelope.
    const after = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, visaCharge.id))
      .get()!;
    expect(after.transferPairId).toBeNull();
  });

  it("still accepts a debit from a checking account", () => {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const debit = seedCheckingDebit(checking.id, "2026-09-05", -50_000);

    const result = markAsCardPayment(
      { transactionId: debit.id, cardAccountId: visa.id },
      handle.db,
    );

    expect(result.status).toBe("ok");
    expect(balanceOf(visa.id)).toBe(-150_000);
  });
});

/**
 * E12's inverse used to derive the mirror from the PARTNER only, so calling it
 * on the mirror's own row refused with "That pair wasn't created here. Unlink
 * it from the Sync page instead." — false, and pointing at the one operation
 * this function exists to keep the user away from.
 */
describe("unmarkCardPayment — works from either leg", () => {
  function pairedPayment() {
    const checking = seedAccount({ name: "Checking", type: "checking" });
    const visa = seedAccount({ name: "Visa", type: "credit" });
    const debit = seedCheckingDebit(checking.id, "2026-09-05", -50_000);
    const marked = markAsCardPayment(
      { transactionId: debit.id, cardAccountId: visa.id },
      handle.db,
    );
    expect(marked.status).toBe("ok");
    const mirror = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, visa.id))
      .get()!;
    return { checking, visa, debit, mirror };
  }

  it("removes the payment when invoked from the MIRROR row", () => {
    const { visa, debit, mirror } = pairedPayment();
    expect(balanceOf(visa.id)).toBe(-150_000);

    const result = unmarkCardPayment({ transactionId: mirror.id }, handle.db);

    expect(result.status).toBe("ok");
    // The mirror is gone and the card balance is back where it started.
    expect(
      handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, mirror.id))
        .get(),
    ).toBeUndefined();
    expect(balanceOf(visa.id)).toBe(-200_000);
    // The real checking row survives, unpaired and unmarked — it is a bank row
    // and deleting it would destroy imported history.
    const source = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, debit.id))
      .get()!;
    expect(source.transferPairId).toBeNull();
    expect(handle.db.select().from(schema.transferPairRejections).all()).toEqual([]);
    // The surviving row's id comes back, not the deleted mirror's.
    if (result.status === "ok") expect(result.transactionId).toBe(debit.id);
  });

  it("still removes the payment when invoked from the source row", () => {
    const { visa, debit, mirror } = pairedPayment();

    const result = unmarkCardPayment({ transactionId: debit.id }, handle.db);

    expect(result.status).toBe("ok");
    expect(
      handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, mirror.id))
        .get(),
    ).toBeUndefined();
    expect(balanceOf(visa.id)).toBe(-200_000);
  });
});

/**
 * `removeCardActivity` — the way back from `createCardActivity`, which had none.
 *
 * Before this existed, a hand-entered charge was the only write in the app with
 * no reverse: the sole transaction deletes were `undoSyncBatch` (a whole batch)
 * and `unmarkCardPayment` (its own synthetic mirror, and it refuses anything
 * else). A mistyped amount or a charge on the wrong card was permanent.
 */
describe("removeCardActivity", () => {
  function seedCardWithCharge() {
    const card = seedAccount({ name: "Visa", type: "credit", cents: -100000, anchor: "2026-01-01" });
    const category = seedCategory();
    const created = createCardActivity(
      {
        kind: "charge",
        accountId: card.id,
        date: "2026-01-05",
        amountCents: 8025,
        merchant: "Costco",
        categoryId: category.id,
      },
      handle.db,
    );
    if (created.status !== "ok") throw new Error(`setup failed: ${created.message}`);
    return { card, created };
  }

  it("deletes the row and moves the balance back", () => {
    const { card, created } = seedCardWithCharge();
    expect(balanceOf(card.id)).toBe(-108025);

    const result = removeCardActivity({ transactionId: created.transactionId }, handle.db);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.balanceCents).toBe(-100000);
    // The quoted figure is read AFTER the commit, so it is the one the row shows.
    expect(result.message).toContain("$1,000.00");
    expect(balanceOf(card.id)).toBe(-100000);
    expect(
      handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, created.transactionId))
        .get(),
    ).toBeUndefined();
  });

  it("removes the row's own batch, which existed only to carry it (E21)", () => {
    const { created } = seedCardWithCharge();
    const row = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.id, created.transactionId))
      .get()!;

    removeCardActivity({ transactionId: created.transactionId }, handle.db);

    expect(
      handle.db
        .select()
        .from(schema.importBatches)
        .where(eq(schema.importBatches.id, row.importBatchId))
        .get(),
    ).toBeUndefined();
  });

  /**
   * The reason this function is worth more than an ordinary undo.
   *
   * `hasAnyTransactionRows` has NO anchor filter (E16), so ONE row flips a
   * feed-linked card off `resolveBalanceAction`'s `refresh` branch and makes
   * `refreshLiabilityBalances` skip it (D7/D15). Before this existed there was
   * no way back to zero rows, so the first hand-entered charge permanently
   * converted a card whose balance the bank maintained into one the user
   * maintains. Both gates ask the same question of the same table, so removing
   * the last row restores it — that round trip is the property, and neither
   * half of it can be seen from a test of either function alone.
   */
  it("RESTORES a feed-linked card's automatic balance by taking the last row away", () => {
    const card = seedAccount({ name: "Visa", type: "credit", cents: -100000, anchor: "2026-01-01" });
    handle.db
      .update(schema.accounts)
      .set({ simplefinAccountId: "ACT-visa" })
      .where(eq(schema.accounts.id, card.id))
      .run();
    const linked = { simplefinAccountId: "ACT-visa" };

    expect(hasAnyTransactionRows(card.id, handle.db)).toBe(false);
    expect(resolveBalanceAction(linked, hasAnyTransactionRows(card.id, handle.db))).toBe("refresh");

    const category = seedCategory();
    const created = createCardActivity(
      {
        kind: "charge",
        accountId: card.id,
        date: "2026-01-05",
        amountCents: 8025,
        merchant: "Costco",
        categoryId: category.id,
      },
      handle.db,
    );
    if (created.status !== "ok") throw new Error("setup failed");

    // One row is enough, and its date is irrelevant — that is E16.
    expect(resolveBalanceAction(linked, hasAnyTransactionRows(card.id, handle.db))).toBe("reconcile");

    removeCardActivity({ transactionId: created.transactionId }, handle.db);

    expect(hasAnyTransactionRows(card.id, handle.db)).toBe(false);
    expect(resolveBalanceAction(linked, hasAnyTransactionRows(card.id, handle.db))).toBe("refresh");
  });

  it("REFUSES a bank row — deleting one would destroy imported history", () => {
    // The guard that matters. Every other refusal here protects a mechanism;
    // this one protects the ledger.
    const checking = seedAccount({
      name: "Checking",
      type: "checking",
      cents: 500000,
      anchor: "2026-01-01",
    });
    const bankRow = seedCheckingDebit(checking.id, "2026-01-05", -8025);

    const result = removeCardActivity({ transactionId: bankRow.id }, handle.db);

    expect(result).toMatchObject({ status: "refused", reason: "not-manual" });
    expect(
      handle.db.select().from(schema.transactions).where(eq(schema.transactions.id, bankRow.id)).get(),
    ).toBeDefined();
  });

  it("REFUSES a payment leg, and names the tool that owns it", () => {
    // Deleting one leg strands the other — the damage E12 describes. The
    // refusal has to point somewhere, or the user's next move is
    // `unlinkTransferPair`, which is the operation E12 exists to avoid.
    const checking = seedAccount({
      name: "Checking",
      type: "checking",
      cents: 500000,
      anchor: "2026-01-01",
    });
    const card = seedAccount({ name: "Visa", type: "credit", cents: -100000, anchor: "2026-01-01" });
    const debit = seedCheckingDebit(checking.id, "2026-02-01", -20000);
    const marked = markAsCardPayment(
      { transactionId: debit.id, cardAccountId: card.id },
      handle.db,
    );
    if (marked.status !== "ok") throw new Error("setup failed");

    const mirror = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, card.id))
      .get()!;

    // From the MIRROR's own row — the manual, card-account leg, which is the
    // one that looks most like something this function should accept.
    const result = removeCardActivity({ transactionId: mirror.id }, handle.db);

    expect(result).toMatchObject({ status: "refused", reason: "already-paired" });
    expect(result.status === "refused" && result.message).toContain("Not a card payment");
    // Both legs survive.
    expect(balanceOf(card.id)).toBe(-80000);
  });

  it("REFUSES a manual row on an account that is not a card (E17)", () => {
    const card = seedAccount({ name: "Visa", type: "credit", cents: -100000, anchor: "2026-01-01" });
    const category = seedCategory();
    const created = createCardActivity(
      {
        kind: "charge",
        accountId: card.id,
        date: "2026-01-05",
        amountCents: 8025,
        merchant: "Costco",
        categoryId: category.id,
      },
      handle.db,
    );
    if (created.status !== "ok") throw new Error("setup failed");
    // Retype the account under it, the way a stale tab or a hand-edited
    // request would reach this.
    handle.db
      .update(schema.accounts)
      .set({ type: "loan" })
      .where(eq(schema.accounts.id, card.id))
      .run();

    const result = removeCardActivity({ transactionId: created.transactionId }, handle.db);

    expect(result).toMatchObject({ status: "refused", reason: "not-a-card" });
  });

  it("refuses a transaction id that no longer exists", () => {
    expect(removeCardActivity({ transactionId: 99999 }, handle.db)).toMatchObject({
      status: "refused",
      reason: "not-found",
    });
  });

  it("a REFUND is removable on the same terms as a charge (E13)", () => {
    const card = seedAccount({ name: "Visa", type: "credit", cents: -100000, anchor: "2026-01-01" });
    const category = seedCategory();
    const created = createCardActivity(
      {
        kind: "refund",
        accountId: card.id,
        date: "2026-01-05",
        amountCents: 8025,
        merchant: "Costco",
        categoryId: category.id,
      },
      handle.db,
    );
    if (created.status !== "ok") throw new Error("setup failed");
    expect(balanceOf(card.id)).toBe(-91975);

    expect(removeCardActivity({ transactionId: created.transactionId }, handle.db).status).toBe("ok");
    expect(balanceOf(card.id)).toBe(-100000);
  });
});

/**
 * The FIFTH guard, and the only one `removeCardActivity`'s own suite above
 * leaves standing: the synthetic-mirror shape (`import_source = 'manual'` AND
 * `category_id IS NULL`).
 *
 * Its docblock calls it belt-and-braces — unreachable while the
 * `transfer_pair_id` check holds — and that is exactly why it needs a test
 * rather than none. The two facts are independent: a mirror left UNPAIRED by a
 * partial failure passes the pair check, and this is the only thing between it
 * and deletion. Delete it and `unmarkCardPayment` is then asked to clean up a
 * partner that no longer exists, from a page with no way back.
 *
 * CLAUDE.md's standing rule for exactly this class: a defensive check reachable
 * only from a stale tab or a crafted post "must not be allowed to drift".
 */
describe("removeCardActivity — the mirror-shape guard", () => {
  it("REFUSES an UNPAIRED payment mirror, and names the tool that owns it", () => {
    const checking = seedAccount({
      name: "Checking",
      type: "checking",
      cents: 500_000,
      anchor: "2026-01-01",
    });
    const card = seedAccount({ name: "Visa", type: "credit", cents: -100_000, anchor: "2026-01-01" });
    const debit = seedCheckingDebit(checking.id, "2026-02-01", -20_000);
    const marked = markAsCardPayment({ transactionId: debit.id, cardAccountId: card.id }, handle.db);
    if (marked.status !== "ok") throw new Error("setup failed");

    const mirror = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.accountId, card.id))
      .get()!;
    // The mirror IS the shape: hand-written and deliberately uncategorized.
    expect(mirror.importSource).toBe("manual");
    expect(mirror.categoryId).toBeNull();

    // Strand it, the way a partial failure would: the pair is gone, so the
    // `already-paired` guard above can no longer catch this row and the
    // category check is the last thing standing.
    handle.db
      .update(schema.transactions)
      .set({ transferPairId: null })
      .where(eq(schema.transactions.id, mirror.id))
      .run();

    const result = removeCardActivity({ transactionId: mirror.id }, handle.db);

    expect(result).toMatchObject({ status: "refused", reason: "invalid" });
    expect(result.status === "refused" && result.message).toContain("Not a card payment");
    // The row survives. Deleting it is the outcome this guard exists to stop.
    expect(
      handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, mirror.id))
        .get(),
    ).toBeDefined();
  });
});
