import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { buildPreview, commitImport, linkTransferPairs, transformRow } from "./importBatch";
import { computeImportRowHash } from "./hash";
import { loadAccountBalances } from "./accounts/loadAccountBalances";
import type { ParsedRow } from "./parseCsv";
import { unlinkTransferPair } from "./simplefin/sync";

// `commitImport` calls `createSnapshot` against a real `data/money.db` path,
// which does not exist in the test environment — stubbed the same way
// `src/lib/simplefin/sync.test.ts` stubs it, so these tests can drive the
// `consistent`/`degradedReason` branch without touching disk.
const { createSnapshotMock, pruneSnapshotsMock } = vi.hoisted(() => ({
  createSnapshotMock: vi.fn(() => ({
    snapshotPath: "/tmp/money.db.pre-import-TEST",
    timestamp: "TEST",
    consistent: true,
    degradedReason: null as string | null,
  })),
  pruneSnapshotsMock: vi.fn(() => ({ prunedPaths: [], failedPaths: [] })),
}));

vi.mock("./snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshot")>()),
  createSnapshot: createSnapshotMock,
  pruneSnapshots: pruneSnapshotsMock,
}));

const STAR_ONE_CSV = [
  "Transaction Number,Date,Description,Memo,Amount Debit,Amount Credit,Balance,Check Number,Fees",
  '12345,04/16/2026,WITHDRAWAL,"TST*THE BRASS TAP - Modesto CA Card #:8568",37.13,,1000.00,,',
].join("\n");

function row(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    rowIndex: 0,
    bankTransactionNumber: "12345",
    date: "2026-04-16",
    rawDescription: "WITHDRAWAL",
    rawMemo: "TST*THE BRASS TAP - Modesto CA Card #:8568",
    amountCents: -3713,
    balanceCents: 10000,
    checkNumber: null,
    fees: null,
    isPending: false,
    ...overrides,
  };
}

describe("transformRow", () => {
  it("computes importRowHash deterministically from the 5 inputs", () => {
    const r = row();
    const result = transformRow(r);
    const expected = computeImportRowHash({
      date: r.date,
      amountCents: r.amountCents,
      rawDescription: r.rawDescription,
      rawMemo: r.rawMemo,
      rowIndex: r.rowIndex,
    });
    expect(result.importRowHash).toBe(expected);
  });

  it("normalizes merchant and extracts card last-four", () => {
    const result = transformRow(row());
    expect(result.normalizedMerchant).toContain("BRASS TAP");
    expect(result.normalizedMerchant).toBe(result.normalizedMerchant.toUpperCase());
    expect(result.cardLastFour).toBe("8568");
  });

  it("returns null cardLastFour when no Card # is present", () => {
    const result = transformRow(row({ rawMemo: "NETFLIX.COM" }));
    expect(result.cardLastFour).toBeNull();
  });

  it("preserves sign, date, and pending flag", () => {
    const deposit = transformRow(
      row({
        rawDescription: "DEPOSIT",
        amountCents: 50000,
        isPending: true,
        bankTransactionNumber: "6098",
      }),
    );
    expect(deposit.amountCents).toBe(50000);
    expect(deposit.rawDescription).toBe("DEPOSIT");
    expect(deposit.isPending).toBe(true);
    expect(deposit.bankTransactionNumber).toBe("6098");
  });

  it("produces distinct hashes for rows that differ only by rowIndex", () => {
    const a = transformRow(row({ rowIndex: 0 }));
    const b = transformRow(row({ rowIndex: 1 }));
    expect(a.importRowHash).not.toBe(b.importRowHash);
  });
});

describe("commitImport", () => {
  let handle: TestDbHandle;
  let accountId: number;

  beforeEach(() => {
    handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    accountId = account.id;
  });

  afterEach(() => {
    handle.close();
  });

  it("commits and reports no warnings when the snapshot is consistent", () => {
    const result = commitImport(
      { accountId, filename: "test.csv", csvText: STAR_ONE_CSV },
      handle.db,
    );
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.warnings).toEqual([]);
    expect(result.snapshot.snapshotPath).toBe("/tmp/money.db.pre-import-TEST");

    const [batch] = handle.db.select().from(schema.importBatches).all();
    expect(batch.snapshotWarning).toBeNull();
    // `label` is the renamed, now-nullable former `filename` column — a CSV
    // batch always carries the real uploaded filename as its label.
    expect(batch.label).toBe("test.csv");
  });

  // TODOS.md P0 / plan T6a — importBatch.ts silently recorded a degraded
  // snapshot as if it were a good rollback target. It must still commit
  // (sync.ts's warn-and-proceed policy, not a new abort behavior) but the
  // caller must be told — durably, on the batch row, not just for the one
  // redirect right after commit (adversarial review: a URL-only warning is
  // forgeable and disappears on a later visit to the success page).
  it("still commits but surfaces a warning when the snapshot degrades to a plain copy", () => {
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: false,
      degradedReason: "database disk image is malformed",
    });

    const result = commitImport(
      { accountId, filename: "test.csv", csvText: STAR_ONE_CSV },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.insertedCount).toBe(1);
    expect(result.snapshot.snapshotPath).toBe("/tmp/money.db.pre-import-TEST");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("database disk image is malformed");

    const [batch] = handle.db.select().from(schema.importBatches).all();
    expect(batch.snapshotPath).toBe("/tmp/money.db.pre-import-TEST");
    expect(batch.snapshotWarning).toContain("database disk image is malformed");
  });

  it("omits the parenthetical when the snapshot degrades with no reason given", () => {
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: false,
      degradedReason: null,
    });

    const result = commitImport(
      { accountId, filename: "test.csv", csvText: STAR_ONE_CSV },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).not.toMatch(/\(null\)|\(\)/);
  });

  // Docker PR review finding: commitImport used to cache DB_PATH/SNAPSHOT_DIR
  // in module-level consts computed once at import time, unlike every other
  // paths.ts consumer (see src/lib/paths.test.ts — "reads process.env at call
  // time, no module-level caching"). A snapshot that silently landed back on
  // DATA_DIR instead of the SNAPSHOT_DIR bind mount would defeat the entire
  // point of splitting them (CLAUDE.md's Docker section: snapshots must
  // survive `docker compose down -v`).
  it("passes the current SNAPSHOT_DIR (not DATA_DIR) to createSnapshot/pruneSnapshots", async () => {
    process.env.DATA_DIR = "/tmp/mm-test-data";
    process.env.SNAPSHOT_DIR = "/tmp/mm-test-backups";
    try {
      const { dbPath, snapshotDir } = await import("./paths");
      createSnapshotMock.mockClear();
      pruneSnapshotsMock.mockClear();

      commitImport(
        { accountId, filename: "test.csv", csvText: STAR_ONE_CSV },
        handle.db,
      );

      expect(createSnapshotMock).toHaveBeenCalledWith(dbPath(), snapshotDir());
      expect(pruneSnapshotsMock).toHaveBeenCalledWith(snapshotDir());
      expect(snapshotDir()).not.toBe(dbPath());
    } finally {
      delete process.env.DATA_DIR;
      delete process.env.SNAPSHOT_DIR;
    }
  });
});

// ---------------------------------------------------------------------------
// Content-overlap dedup. `import_row_hash` mixes in the row's index within its
// source file, and Star One exports an arbitrary date range — so a wider
// re-export of history already in the ledger changes every hash and the
// hash-only dedup sees nothing. Reproduced during the load-the-ledger review:
// 10 parsed, 10 new, 0 duplicates, 5 transactions counted twice.
// ---------------------------------------------------------------------------

type CsvRow = {
  txn: string;
  date: string;
  memo: string;
  /** Signed dollars. Negative lands in Amount Debit, positive in Amount Credit. */
  amount: number;
  balance: number;
};

function starOneCsv(rows: CsvRow[]): string {
  const header =
    "Transaction Number,Date,Description,Memo,Amount Debit,Amount Credit,Balance,Check Number,Fees";
  const lines = rows.map((r) =>
    [
      r.txn,
      r.date,
      r.amount < 0 ? "WITHDRAWAL" : "DEPOSIT",
      `"${r.memo}"`,
      r.amount < 0 ? r.amount.toFixed(2) : "",
      r.amount > 0 ? r.amount.toFixed(2) : "",
      r.balance.toFixed(2),
      "",
      "",
    ].join(","),
  );
  return [header, ...lines].join("\n");
}

const COFFEE: CsvRow = {
  txn: "1001",
  date: "04/16/2026",
  memo: "STARBUCKS STORE 1234 MANTECA CA",
  amount: -4.87,
  balance: 1000,
};
const GAS: CsvRow = {
  txn: "1002",
  date: "04/17/2026",
  memo: "CHEVRON 00201234 MANTECA CA",
  amount: -52.1,
  balance: 947.9,
};
const PAY: CsvRow = {
  txn: "1003",
  date: "04/18/2026",
  memo: "DIRECT DEPOSIT PAYROLL",
  amount: 1200,
  balance: 2147.9,
};

describe("buildPreview — dedup across differently-ranged exports", () => {
  let handle: TestDbHandle;
  let accountId: number;

  function newAccount(name: string): number {
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name,
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    return account.id;
  }

  beforeEach(() => {
    handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    accountId = newAccount("Checking");
  });

  afterEach(() => {
    handle.close();
  });

  it("flags a wider re-export of already-imported rows as duplicates", () => {
    commitImport(
      { accountId, filename: "narrow.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );

    // The same two transactions, now at row indices 1 and 2 because a newer row
    // was exported above them. Every hash differs from the committed ones.
    const wider = starOneCsv([PAY, COFFEE, GAS]);
    const preview = buildPreview(
      { accountId, filename: "wide.csv", csvText: wider },
      handle.db,
    );

    expect(preview.totals.parsedRows).toBe(3);
    expect(preview.totals.duplicates).toBe(2);
    expect(preview.totals.newRows).toBe(1);
    expect(preview.rows.map((r) => r.duplicateReason)).toEqual([
      null,
      "content",
      "content",
    ]);
  });

  it("still reports an identical re-import as a hash duplicate", () => {
    const csvText = starOneCsv([COFFEE, GAS]);
    commitImport({ accountId, filename: "a.csv", csvText }, handle.db);

    const preview = buildPreview(
      { accountId, filename: "a.csv", csvText },
      handle.db,
    );
    expect(preview.totals.duplicates).toBe(2);
    expect(preview.totals.newRows).toBe(0);
    expect(preview.rows.every((r) => r.duplicateReason === "hash")).toBe(true);
  });

  // CLAUDE.md rule 3: two genuinely identical same-day coffees are two
  // transactions, not one. The content pass counts signatures as a multiset for
  // exactly this reason — collapsing them into a Set would make the second one
  // permanently unimportable.
  it("keeps a second genuinely identical same-day row importable", () => {
    const preview = buildPreview(
      { accountId, filename: "two-coffees.csv", csvText: starOneCsv([COFFEE, COFFEE]) },
      handle.db,
    );
    expect(preview.totals.newRows).toBe(2);
    expect(preview.totals.duplicates).toBe(0);

    const result = commitImport(
      { accountId, filename: "two-coffees.csv", csvText: starOneCsv([COFFEE, COFFEE]) },
      handle.db,
    );
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.insertedCount).toBe(2);
  });

  // The ordering guard: a hash-matched row claims its own existing row's budget
  // before any content comparison runs. Without that, the file's first row
  // matches by hash, the second identical row then spends the budget belonging
  // to that same already-accounted-for ledger row, and a real second coffee is
  // silently dropped as a duplicate.
  it("does not let a hash-matched row's budget swallow a real second occurrence", () => {
    commitImport(
      { accountId, filename: "one-coffee.csv", csvText: starOneCsv([COFFEE]) },
      handle.db,
    );

    const preview = buildPreview(
      { accountId, filename: "two-coffees.csv", csvText: starOneCsv([COFFEE, COFFEE]) },
      handle.db,
    );

    expect(preview.rows[0].duplicateReason).toBe("hash");
    expect(preview.rows[1].duplicate).toBe(false);
    expect(preview.totals.newRows).toBe(1);
  });

  it("matches a padded pending memo against the posted row's trimmed one", () => {
    commitImport(
      {
        accountId,
        filename: "pending.csv",
        csvText: starOneCsv([{ ...COFFEE, memo: `   ${COFFEE.memo}` }]),
      },
      handle.db,
    );

    const preview = buildPreview(
      { accountId, filename: "posted.csv", csvText: starOneCsv([PAY, COFFEE]) },
      handle.db,
    );
    expect(preview.rows[1].duplicateReason).toBe("content");
    expect(preview.totals.newRows).toBe(1);
  });

  it("does not treat another account's identical row as a duplicate", () => {
    const savingsId = newAccount("Savings");
    commitImport(
      { accountId: savingsId, filename: "savings.csv", csvText: starOneCsv([COFFEE]) },
      handle.db,
    );

    const preview = buildPreview(
      { accountId, filename: "checking.csv", csvText: starOneCsv([COFFEE]) },
      handle.db,
    );
    expect(preview.totals.duplicates).toBe(0);
    expect(preview.totals.newRows).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Auto-categorization at import. `applyRuleAtImport` shipped in the rule engine
// with 14 assertions and a CHANGELOG entry, and had zero production callers for
// six releases — so every import landed 100% uncategorized no matter how many
// rules were trained, and the backlog only ever grew.
// ---------------------------------------------------------------------------
describe("commitImport — auto-categorization", () => {
  let handle: TestDbHandle;
  let accountId: number;
  let categoryId: number;

  /** The exact string the rule engine keys on, derived rather than guessed. */
  const COFFEE_MERCHANT = transformRow(
    row({ rawMemo: COFFEE.memo }),
  ).normalizedMerchant;
  const GAS_MERCHANT = transformRow(row({ rawMemo: GAS.memo })).normalizedMerchant;

  beforeEach(() => {
    handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    accountId = account.id;
    // Migration 0002 seeds Uncategorized + 5 default leaf categories, so these
    // are looked up rather than inserted.
    categoryId = categoryByName("Dining");
  });

  afterEach(() => {
    handle.close();
  });

  function categoryByName(name: string): number {
    const [category] = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, name))
      .all();
    if (!category) throw new Error(`seed category "${name}" missing`);
    return category.id;
  }

  function committedRows() {
    return handle.db
      .select({
        normalizedMerchant: schema.transactions.normalizedMerchant,
        categoryId: schema.transactions.categoryId,
      })
      .from(schema.transactions)
      .all();
  }

  it("categorizes a row matched by a trained exact rule", () => {
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId,
        matchType: "exact",
        matchValue: COFFEE_MERCHANT,
        source: "manual",
      })
      .run();

    commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );

    const rows = committedRows();
    expect(rows).toHaveLength(2);
    expect(
      rows.find((r) => r.normalizedMerchant === COFFEE_MERCHANT)?.categoryId,
    ).toBe(categoryId);
  });

  // CLAUDE.md rule 6: unmatched rows stay NULL, which is what the dashboard
  // backlog tile counts. The seeded "Uncategorized" category is for manual
  // overrides and must never be applied here.
  it("leaves an unmatched row NULL", () => {
    commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([GAS]) },
      handle.db,
    );
    expect(committedRows()[0].categoryId).toBeNull();
  });

  it("resolves through contains and regex rules, not just exact ones", () => {
    const regexCategoryId = categoryByName("Groceries");
    handle.db
      .insert(schema.categoryRules)
      .values([
        {
          categoryId,
          matchType: "contains",
          matchValue: "STARBUCKS",
          source: "manual",
        },
        {
          categoryId: regexCategoryId,
          matchType: "regex",
          matchValue: `^${GAS_MERCHANT}$`,
          source: "manual",
        },
      ])
      .run();

    commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );

    const rows = committedRows();
    expect(
      rows.find((r) => r.normalizedMerchant === COFFEE_MERCHANT)?.categoryId,
    ).toBe(categoryId);
    expect(
      rows.find((r) => r.normalizedMerchant === GAS_MERCHANT)?.categoryId,
    ).toBe(regexCategoryId);
  });

  it("honours rule priority for a row two rules both match", () => {
    const otherId = categoryByName("Groceries");
    handle.db
      .insert(schema.categoryRules)
      .values([
        {
          categoryId,
          matchType: "contains",
          matchValue: "STARBUCKS",
          priority: 10,
          source: "auto",
        },
        {
          categoryId: otherId,
          matchType: "exact",
          matchValue: COFFEE_MERCHANT,
          priority: 90,
          source: "manual",
        },
      ])
      .run();

    commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE]) },
      handle.db,
    );
    expect(committedRows()[0].categoryId).toBe(otherId);
  });

  // Without this, undoImportCategorization (TODOS.md P1 — migration 0006's 23
  // broad `contains` rules with no bulk undo) has no way to know which rows a
  // batch's rule matching touched.
  it("records an import_batch_categorizations row for every rule-matched insert, and none for unmatched rows", () => {
    const [rule] = handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId,
        matchType: "exact",
        matchValue: COFFEE_MERCHANT,
        source: "manual",
      })
      .returning()
      .all();

    const result = commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("expected commit");

    const audit = handle.db
      .select()
      .from(schema.importBatchCategorizations)
      .where(eq(schema.importBatchCategorizations.importBatchId, result.batchId))
      .all();
    expect(audit).toHaveLength(1);
    expect(audit[0].categoryId).toBe(categoryId);
    expect(audit[0].ruleId).toBe(rule.id);

    const coffeeRow = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.normalizedMerchant, COFFEE_MERCHANT))
      .get();
    expect(audit[0].transactionId).toBe(coffeeRow?.id);
  });
});

// ---------------------------------------------------------------------------
// Starting-balance anchor. Both real accounts were created with
// starting_balance_cents = 0, so every displayed balance is net-change-since-
// signup rather than a balance — and once an account is linked, /sync's drift
// check compares that fabricated figure against the bank's real one and reports
// a phantom missing row forever. The CSV has carried the answer all along.
// ---------------------------------------------------------------------------
describe("commitImport — starting balance anchor", () => {
  let handle: TestDbHandle;
  let accountId: number;

  beforeEach(() => {
    handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    accountId = account.id;
  });

  afterEach(() => {
    handle.close();
  });

  function account() {
    const [a] = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .all();
    return a;
  }

  // The actual motivation for moving anchorStartingBalance's write inside
  // commitImport's transaction: prove it's really atomic with the row
  // inserts, not just "happens to always succeed together." Forces a real
  // exception from a later write in the same transaction and asserts the
  // account's anchor (written earlier in that same transaction) rolled back
  // along with everything else, rather than sticking as a partial write.
  it("rolls back the account's anchor move when a later write in the same transaction fails", () => {
    type TxParam = Parameters<Parameters<typeof handle.db.transaction>[0]>[0];
    let importBatchesUpdateCalls = 0;
    const dbProxy = new Proxy(handle.db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (cb: (tx: TxParam) => unknown) =>
          (Reflect.get(target, "transaction", target) as typeof target.transaction).call(
            target,
            (tx: TxParam) => {
              const txProxy = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp !== "update") return Reflect.get(txTarget, txProp, txReceiver);
                  return (table: unknown) => {
                    if (table === schema.importBatches) {
                      importBatchesUpdateCalls++;
                      // 1st call is the transactionCount update (let it pass);
                      // 2nd is the anchor-columns update anchorStartingBalance
                      // triggers — fail exactly that one.
                      if (importBatchesUpdateCalls === 2) {
                        throw new Error("simulated failure after anchor move");
                      }
                    }
                    return (txTarget.update as (t: unknown) => unknown)(table);
                  };
                },
              });
              return cb(txProxy);
            },
          );
      },
    });

    expect(() =>
      commitImport(
        { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
        dbProxy as typeof handle.db,
      ),
    ).toThrow("simulated failure after anchor move");

    // The whole transaction rolled back, including anchorStartingBalance's
    // account-row write — which ran earlier in the very same transaction.
    expect(account().startingBalanceCents).toBe(0);
    expect(account().startingBalanceDate).toBe("2026-01-01");
    // The row inserts rolled back too, not just the anchor.
    expect(handle.db.select().from(schema.transactions).all()).toHaveLength(0);
  });

  it("persists the anchor onto the batch it came from, not just the account", () => {
    const result = commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("unreachable");

    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.anchoredStartingBalanceCents).toBe(100000);
    expect(batch.anchoredStartingBalanceDate).toBe("2026-04-16");
  });

  // The record that lets a bad automatic anchor move be corrected via
  // updateAccountAnchorAction without guessing what the old value was.
  it("records the account's prior anchor on the batch when it moves the anchor", () => {
    const result = commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("unreachable");

    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.priorStartingBalanceCents).toBe(0);
    expect(batch.priorStartingBalanceDate).toBe("2026-01-01");
  });

  // The prior-value capture has to read the account's CURRENT anchor at move
  // time, not some cached "original" value — otherwise a second move in a
  // row of imports would keep pointing a revert at the wrong (stale) value.
  it("records the immediately-prior anchor on a second sequential move, not the original", () => {
    commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
      handle.db,
    );
    expect(account().startingBalanceCents).toBe(100000);
    expect(account().startingBalanceDate).toBe("2026-04-16");

    const later = { ...COFFEE, txn: "9002", date: "04/20/2026", balance: 3000 };
    const result = commitImport(
      { accountId, filename: "second.csv", csvText: starOneCsv([later]) },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("unreachable");

    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.priorStartingBalanceCents).toBe(100000);
    expect(batch.priorStartingBalanceDate).toBe("2026-04-16");
    expect(batch.anchoredStartingBalanceCents).toBe(300000);
    expect(batch.anchoredStartingBalanceDate).toBe("2026-04-20");
  });

  // A single-row file trivially satisfies the running-balance chain check
  // (the loop over adjacent pairs never runs), so nothing corroborates its
  // Balance cell. Without a bounds check, one corrupted or hand-edited row
  // would otherwise anchor the account on whatever that row's Balance says.
  it("declines to move the anchor when the derived balance is outside the allowed range, and warns", () => {
    const wild = { ...COFFEE, balance: 200_000_000 };
    const result = commitImport(
      { accountId, filename: "wild.csv", csvText: starOneCsv([wild]) },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("unreachable");

    expect(result.startingBalance).toBeNull();
    expect(result.warnings).toContain(
      "Declined to move the starting-balance anchor: the derived balance ($200000000.00) is outside the allowed range.",
    );
    expect(account().startingBalanceCents).toBe(0);
    expect(account().startingBalanceDate).toBe("2026-01-01");

    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.anchoredStartingBalanceCents).toBeNull();
    // The regression this whole test file previously missed: a caught-but-
    // unpersisted warning is invisible in production, since the import
    // success page renders `batch.snapshotWarning`, never `result.warnings`
    // (which nothing downstream of `commitImport` actually reads).
    expect(batch.snapshotWarning).toContain("outside the allowed range");
  });

  // Mirrors validateUpdateAnchorInput's future-date guard: loadAccountBalances
  // sums only rows dated strictly after the anchor, so a future anchor would
  // exclude every real transaction and freeze the displayed balance. A real
  // Star One CSV can't produce this, but nothing upstream guarantees that.
  it("declines to move the anchor when the derived date is in the future, and warns", () => {
    const future = { ...COFFEE, date: "04/16/2099", balance: 5000 };
    const result = commitImport(
      { accountId, filename: "future.csv", csvText: starOneCsv([future]) },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("unreachable");

    expect(result.startingBalance).toBeNull();
    expect(result.warnings).toContain(
      'Declined to move the starting-balance anchor: the derived date "2099-04-16" is in the future.',
    );
    expect(account().startingBalanceCents).toBe(0);
    expect(account().startingBalanceDate).toBe("2026-01-01");

    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.snapshotWarning).toContain("is in the future");
  });

  it("leaves the batch's anchor fields null when this import declined to move the anchor", () => {
    // First import anchors the account at 2026-04-16.
    commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
      handle.db,
    );

    // A second, all-new-rows import dated entirely BEFORE the existing anchor
    // can't move it forward — anchorStartingBalance declines (derived.date <
    // account.startingBalanceDate) and returns null.
    const older = { ...COFFEE, txn: "9001", date: "04/01/2026", balance: 5000 };
    const result = commitImport(
      { accountId, filename: "second.csv", csvText: starOneCsv([older]) },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.startingBalance).toBeNull();

    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.anchoredStartingBalanceCents).toBeNull();
    expect(batch.anchoredStartingBalanceDate).toBeNull();
  });

  it("persists each row's running balance", () => {
    commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
      handle.db,
    );

    const balances = handle.db
      .select({
        date: schema.transactions.date,
        balanceCents: schema.transactions.balanceCents,
      })
      .from(schema.transactions)
      .all()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => r.balanceCents);
    expect(balances).toEqual([100000, 94790, 214790]);
  });

  it("anchors the account on the earliest date's closing balance", () => {
    const result = commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.startingBalance).toEqual({
      date: "2026-04-16",
      startingBalanceCents: 100000,
    });
    expect(account().startingBalanceCents).toBe(100000);
    expect(account().startingBalanceDate).toBe("2026-04-16");
  });

  // The point of the whole task: the displayed balance becomes the bank's
  // balance, so /sync's drift check reads 0 instead of crying wolf.
  it("makes the computed balance match the file's last running balance", () => {
    commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
      handle.db,
    );

    const [balance] = loadAccountBalances(handle.db);
    expect(balance.balanceCents).toBe(214790);
  });

  it("reads a newest-first export the same way", () => {
    commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([PAY, GAS, COFFEE]) },
      handle.db,
    );
    expect(account().startingBalanceCents).toBe(100000);
    expect(account().startingBalanceDate).toBe("2026-04-16");
  });

  // Any (date, true closing balance) pair is a valid anchor, but a later one
  // needs less history to be complete for the sum to come out right.
  it("never moves the anchor backwards in time", () => {
    commitImport(
      { accountId, filename: "recent.csv", csvText: starOneCsv([PAY]) },
      handle.db,
    );
    expect(account().startingBalanceDate).toBe("2026-04-18");

    const older: CsvRow = { ...COFFEE, txn: "900", date: "03/02/2026", balance: 500 };
    commitImport(
      { accountId, filename: "older.csv", csvText: starOneCsv([older]) },
      handle.db,
    );
    expect(account().startingBalanceDate).toBe("2026-04-18");
    expect(account().startingBalanceCents).toBe(214790);
  });

  it("leaves the anchor alone when the running balance does not chain, and warns", () => {
    const broken = starOneCsv([COFFEE, { ...GAS, balance: 88888 }]);
    const result = commitImport(
      { accountId, filename: "broken.csv", csvText: broken },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.startingBalance).toBeNull();
    expect(result.warnings).toContain(
      "Declined to move the starting-balance anchor: running balance column does not form a consistent chain.",
    );
    expect(account().startingBalanceCents).toBe(0);
    expect(account().startingBalanceDate).toBe("2026-01-01");

    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.snapshotWarning).toContain("does not form a consistent chain");
  });

  // A same-day paycheck-and-bill pair (deriveStartingBalance.test.ts's
  // ambiguous-anchor case) is real, non-corrupt data — unlike a broken chain,
  // it's likely to occur on ordinary imports, so it gets the same warning
  // treatment rather than staying silent.
  it("leaves the anchor alone when both chronological directions disagree, and warns", () => {
    const paycheckThenBill = [
      { ...COFFEE, txn: "9101", amount: 500, balance: 1500 },
      { ...COFFEE, txn: "9102", amount: -500, balance: 1000 },
    ];
    const result = commitImport(
      { accountId, filename: "ambiguous.csv", csvText: starOneCsv(paycheckThenBill) },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.startingBalance).toBeNull();
    expect(result.warnings).toContain(
      "Declined to move the starting-balance anchor: running balance validates in both directions with disagreeing anchors — refusing to guess.",
    );
    expect(account().startingBalanceCents).toBe(0);
    expect(account().startingBalanceDate).toBe("2026-01-01");

    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.snapshotWarning).toContain("disagreeing anchors");
  });

  // The far more common decline reason — an all-pending or Balance-less
  // import — is not evidence of a problem and must stay silent, unlike the
  // two "we had data but it didn't resolve" cases above.
  it("stays silent (no warning) when there are simply no posted rows to derive from", () => {
    // Star One's pending heuristic keys on the placeholder txn number "6098"
    // with a blank/zero balance (see the "pending" fixture used elsewhere in
    // this file for the posted-re-export tests).
    const allPending = { ...COFFEE, txn: "6098", balance: 0 };
    const result = commitImport(
      { accountId, filename: "pending-only.csv", csvText: starOneCsv([allPending]) },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.startingBalance).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  // Rows already in the ledger are still links in the running-balance chain.
  // Deriving from only the new rows would break it on every overlapping export.
  it("derives from every parsed row, including ones already imported", () => {
    commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );

    const result = commitImport(
      { accountId, filename: "wider.csv", csvText: starOneCsv([COFFEE, GAS, PAY]) },
      handle.db,
    );
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.insertedCount).toBe(1);
    expect(result.startingBalance).toEqual({
      date: "2026-04-16",
      startingBalanceCents: 100000,
    });
    expect(loadAccountBalances(handle.db)[0].balanceCents).toBe(214790);
  });
});

// ---------------------------------------------------------------------------
// Coverage audit additions: branches the load-the-ledger change introduced but
// left unpinned — the empty-file short-circuit, the cross-source reason the
// content pass deliberately omits an `external_id` filter, the all-duplicate
// early return that skips the anchor write, and the two anchor edges (pending
// rows, an anchor refreshed on its own date).
// ---------------------------------------------------------------------------
describe("buildPreview — degenerate inputs", () => {
  let handle: TestDbHandle;
  let accountId: number;

  beforeEach(() => {
    handle = createTestDb();
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    accountId = account.id;
  });

  afterEach(() => {
    handle.close();
  });

  // `transformed.length > 0` guards the whole content pass — a header-only
  // export (Star One returns one for an empty date range) must not read
  // `transformed[0].date` off an empty array.
  it("returns zeroed totals for a header-only export without touching the content pass", () => {
    const preview = buildPreview(
      { accountId, filename: "empty.csv", csvText: starOneCsv([]) },
      handle.db,
    );
    expect(preview.rows).toEqual([]);
    expect(preview.totals).toEqual({
      parsedRows: 0,
      newRows: 0,
      duplicates: 0,
      errors: 0,
      pendingRows: 0,
    });
  });

  // The content pass deliberately omits sync's `external_id` filter: a CSV
  // re-export legitimately overlaps rows that arrived from a SimpleFIN sync,
  // and those carry no comparable `import_row_hash` at all (it is derived from
  // the feed id, never a row index). This is the stated reason for the whole
  // second pass on the CSV side and was the one path with no test.
  it("flags a row already imported by a SimpleFIN sync as a content duplicate", () => {
    const [batch] = handle.db
      .insert(schema.importBatches)
      .values({ source: "simplefin", transactionCount: 1 })
      .returning()
      .all();
    handle.db
      .insert(schema.transactions)
      .values({
        accountId,
        date: "2026-04-16",
        rawDescription: "WITHDRAWAL",
        // The feed sends this trimmed; the CSV pads it. Both normalise here.
        rawMemo: COFFEE.memo,
        normalizedMerchant: transformRow(row({ rawMemo: COFFEE.memo }))
          .normalizedMerchant,
        amountCents: -487,
        importSource: "simplefin",
        importBatchId: batch.id,
        importRowHash: "feed-derived-hash",
        externalId: "TRN-1",
      })
      .run();

    const preview = buildPreview(
      { accountId, filename: "overlap.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );

    expect(preview.rows[0].duplicateReason).toBe("content");
    expect(preview.rows[1].duplicate).toBe(false);
    expect(preview.totals.newRows).toBe(1);
  });
});

describe("commitImport — a pending row's posted re-export updates it in place", () => {
  let handle: TestDbHandle;
  let accountId: number;

  beforeEach(() => {
    handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    accountId = account.id;
  });

  afterEach(() => {
    handle.close();
  });

  const pending = {
    txn: "6098",
    date: "04/19/2026",
    memo: "   PENDING DEPOSIT",
    amount: 25,
    balance: 0,
  };
  const posted = {
    txn: "1099",
    date: "04/19/2026",
    memo: "PENDING DEPOSIT",
    amount: 25,
    balance: 125,
  };

  it("flips is_pending, and fills balance/txn-number/hash from the posted row — without inserting a second row", () => {
    commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([COFFEE, pending]) },
      handle.db,
    );
    const [beforePending] = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.isPending, true))
      .all();
    expect(beforePending.bankTransactionNumber).toBe("6098");

    const result = commitImport(
      { accountId, filename: "second.csv", csvText: starOneCsv([COFFEE, posted]) },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("unreachable");

    // The posted row content-matched the pending one and was never inserted —
    // still one row for this transaction, not two.
    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(2);

    const updated = rows.find((r) => r.id === beforePending.id)!;
    expect(updated.isPending).toBe(false);
    expect(updated.balanceCents).toBe(12500);
    expect(updated.bankTransactionNumber).toBe("1099");
    // The pending row keeps its ORIGINAL id and batch attribution — it was
    // updated, not replaced.
    expect(updated.importBatchId).toBe(beforePending.importBatchId);
  });

  it("survives an all-updates file that inserts nothing new — the empty-batch early return must not skip the update", () => {
    commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([pending]) },
      handle.db,
    );

    // Second file re-exports ONLY the now-posted row — zero brand-new rows.
    const result = commitImport(
      { accountId, filename: "second.csv", csvText: starOneCsv([posted]) },
      handle.db,
    );

    if (result.status !== "committed") {
      throw new Error(
        `expected the update to still commit, got status=${result.status}`,
      );
    }
    const [row] = handle.db.select().from(schema.transactions).all();
    expect(row.isPending).toBe(false);
    expect(row.balanceCents).toBe(12500);
  });

  it("leaves a genuinely repeated posted duplicate alone — does not overwrite an unrelated row's identity", () => {
    // Rule 3: two rows that happen to share a content signature but are BOTH
    // already posted are a real repeat, not a pending→posted transition. The
    // second one must stay a plain duplicate — it must not steal the first
    // row's bank_transaction_number or import_row_hash.
    commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([posted]) },
      handle.db,
    );
    const [original] = handle.db.select().from(schema.transactions).all();

    // A different leading row shifts `posted`'s row index between files, so it
    // content-matches (same date|amount|memo) without also hash-matching —
    // exercising the branch this test is actually about.
    const preview = buildPreview(
      { accountId, filename: "second.csv", csvText: starOneCsv([GAS, posted]) },
      handle.db,
    );
    const postedPreviewRow = preview.rows.find((r) => r.amountCents > 0)!;
    expect(postedPreviewRow.duplicate).toBe(true);
    expect(postedPreviewRow.duplicateReason).toBe("content");
    expect(postedPreviewRow.updateExistingRowId).toBeNull();

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(original);
  });

  it("never writes a second import_batch_categorizations row when a pending row is only updated to posted", () => {
    // The pending row itself goes through `toInsert` (not `toUpdate`) on its
    // first import, so a matching rule DOES categorize and audit it there.
    // The point of this test is the SECOND commit: the posted re-export takes
    // the `toUpdate` branch, which never reads `matchRule` or touches
    // `categoryId` at all — so it must not add a second audit row, and the
    // one audit row that exists must stay attributed to the original batch.
    const dining = handle.db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.name, "Dining"))
      .get()!;
    const pendingMerchant = transformRow(row({ rawMemo: pending.memo })).normalizedMerchant;
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId: dining.id,
        matchType: "exact",
        matchValue: pendingMerchant,
        source: "manual",
      })
      .run();

    const first = commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([pending]) },
      handle.db,
    );
    if (first.status !== "committed") throw new Error("expected commit");

    const auditAfterFirst = handle.db
      .select()
      .from(schema.importBatchCategorizations)
      .all();
    expect(auditAfterFirst).toHaveLength(1);
    expect(auditAfterFirst[0].importBatchId).toBe(first.batchId);

    const second = commitImport(
      { accountId, filename: "second.csv", csvText: starOneCsv([posted]) },
      handle.db,
    );
    if (second.status !== "committed") throw new Error("expected commit");

    const auditAfterSecond = handle.db
      .select()
      .from(schema.importBatchCategorizations)
      .all();
    // Still exactly one row, still attributed to the FIRST batch — the update
    // pass wrote no audit row of its own.
    expect(auditAfterSecond).toHaveLength(1);
    expect(auditAfterSecond[0].importBatchId).toBe(first.batchId);

    const [row_] = handle.db.select().from(schema.transactions).all();
    expect(row_.categoryId).toBe(dining.id);
    expect(row_.isPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `linkTransferPairs` re-checks rows updated from pending to posted, not just
// freshly-inserted ones. A `toUpdate` row keeps its ORIGINAL batch's id, so a
// re-export whose only new information is a pending leg posting used to seed
// pairing with nothing — the real transfer leg on the other account could
// never be found, even once both legs existed with matching (txn ± 1) numbers.
// ---------------------------------------------------------------------------

describe("commitImport — transfer pairing re-checks toUpdate rows", () => {
  let handle: TestDbHandle;
  let checkingId: number;
  let savingsId: number;

  function newAccount(name: string, type: "checking" | "savings"): number {
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name,
        type,
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    return account.id;
  }

  beforeEach(() => {
    handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    checkingId = newAccount("Checking", "checking");
    savingsId = newAccount("Savings", "savings");
  });

  afterEach(() => {
    handle.close();
  });

  it("still pairs two freshly-inserted rows across accounts in one batch each", () => {
    commitImport(
      {
        accountId: checkingId,
        filename: "checking.csv",
        csvText: starOneCsv([
          { txn: "3051", date: "04/20/2026", memo: "TRANSFER TO SAVINGS", amount: -25, balance: 975 },
        ]),
      },
      handle.db,
    );
    const result = commitImport(
      {
        accountId: savingsId,
        filename: "savings.csv",
        csvText: starOneCsv([
          { txn: "3052", date: "04/20/2026", memo: "TRANSFER FROM CHECKING", amount: 25, balance: 1025 },
        ]),
      },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("expected commit");
    expect(result.pairsLinked).toBe(1);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows.every((r) => r.transferPairId !== null)).toBe(true);
  });

  it("pairs a transfer whose leg only became postable once a pending row posted (the toUpdate gap)", () => {
    // The checking side arrives PENDING first, under Star One's placeholder
    // transaction number — it cannot pair with anything yet.
    commitImport(
      {
        accountId: checkingId,
        filename: "checking-pending.csv",
        csvText: starOneCsv([
          { txn: "6098", date: "04/20/2026", memo: "   PENDING DEPOSIT", amount: 25, balance: 0 },
        ]),
      },
      handle.db,
    );

    // The real other leg posts on the savings account in the meantime. At
    // this point nothing can pair with it yet either.
    const savingsResult = commitImport(
      {
        accountId: savingsId,
        filename: "savings.csv",
        csvText: starOneCsv([
          { txn: "3051", date: "04/20/2026", memo: "TRANSFER TO CHECKING", amount: -25, balance: 975 },
        ]),
      },
      handle.db,
    );
    if (savingsResult.status !== "committed") throw new Error("expected commit");
    expect(savingsResult.pairsLinked).toBe(0);

    // The checking leg finally posts — a re-export carrying ONLY the
    // now-posted version of the same content-matched row, so this batch
    // inserts nothing new (`toInsert` is empty) and only updates the existing
    // pending row in place (`toUpdate`). Its real bank transaction number
    // (3052) is exactly ±1 from the savings leg's (3051).
    const checkingResult = commitImport(
      {
        accountId: checkingId,
        filename: "checking-posted.csv",
        csvText: starOneCsv([
          { txn: "3052", date: "04/20/2026", memo: "PENDING DEPOSIT", amount: 25, balance: 1025 },
        ]),
      },
      handle.db,
    );
    if (checkingResult.status !== "committed") throw new Error("expected commit");

    // Without seeding from the toUpdate row, this was 0 and the pair was
    // never found even though both real legs now exist with matching numbers.
    expect(checkingResult.pairsLinked).toBe(1);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.transferPairId !== null)).toBe(true);

    // The persisted count on THIS batch must reflect the pair even though the
    // linked row (the pending one) belongs to an EARLIER batch — a
    // `COUNT(*) WHERE import_batch_id = checkingResult.batchId` would find
    // zero rows here and silently undercount on the success page.
    const [checkingBatch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, checkingResult.batchId))
      .all();
    expect(checkingBatch.pairsLinkedCount).toBe(1);
    const rowsTaggedWithThisBatch = rows.filter(
      (r) => r.importBatchId === checkingResult.batchId,
    );
    expect(rowsTaggedWithThisBatch).toHaveLength(0);
  });

  it("seeds from BOTH freshly-inserted and toUpdate ids in the same commitImport call", () => {
    // Pre-existing pending row on checking — unpaired, placeholder txn number.
    commitImport(
      {
        accountId: checkingId,
        filename: "checking-pending.csv",
        csvText: starOneCsv([
          { txn: "6098", date: "04/21/2026", memo: "   PENDING DEPOSIT", amount: 40, balance: 0 },
        ]),
      },
      handle.db,
    );

    // Savings already carries BOTH real counterparts, unpaired: one for the
    // pending row above (once it posts), one for a brand-new row that will
    // arrive in the checking import below.
    commitImport(
      {
        accountId: savingsId,
        filename: "savings.csv",
        csvText: starOneCsv([
          { txn: "5001", date: "04/21/2026", memo: "TRANSFER TO CHECKING", amount: -40, balance: 960 },
          { txn: "8001", date: "04/23/2026", memo: "TRANSFER TO CHECKING", amount: -15, balance: 945 },
        ]),
      },
      handle.db,
    );

    // One checking import, one file, two rows: the pending row finally posts
    // (toUpdate — keeps its original batch id) AND an unrelated brand-new
    // transfer leg arrives (toInsert — carries this batch's id). Both must be
    // seeded into the same linkTransferPairs call for both pairs to link.
    const result = commitImport(
      {
        accountId: checkingId,
        filename: "checking-mixed.csv",
        csvText: starOneCsv([
          { txn: "5002", date: "04/21/2026", memo: "PENDING DEPOSIT", amount: 40, balance: 1000 },
          { txn: "8002", date: "04/23/2026", memo: "TRANSFER FROM SAVINGS", amount: 15, balance: 1015 },
        ]),
      },
      handle.db,
    );
    if (result.status !== "committed") throw new Error("expected commit");

    // A fix that only seeded from `toUpdate` (or only from `insertedIds`)
    // would find just one of these two pairs, not both.
    expect(result.pairsLinked).toBe(2);

    const rows = handle.db.select().from(schema.transactions).all();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.transferPairId !== null)).toBe(true);

    // Persisted count reflects both pairs even though only ONE of the two
    // linked rows (the fresh insert) actually carries this batch's id.
    const [batch] = handle.db
      .select()
      .from(schema.importBatches)
      .where(eq(schema.importBatches.id, result.batchId))
      .all();
    expect(batch.pairsLinkedCount).toBe(2);
  });
});

describe("linkTransferPairs", () => {
  it("returns 0 and touches nothing when seedRowIds is empty", () => {
    const handle = createTestDb();
    try {
      expect(linkTransferPairs([], handle.db)).toBe(0);
    } finally {
      handle.close();
    }
  });

  function newAccount(db: TestDbHandle["db"], name: string, type: "checking" | "savings"): number {
    const [account] = db
      .insert(schema.accounts)
      .values({ name, type, startingBalanceCents: 0, startingBalanceDate: "2026-01-01" })
      .returning()
      .all();
    return account.id;
  }

  // Star One reuses "6098" as a placeholder transaction number across every
  // still-pending row (CLAUDE.md rule 3). Before filtering on is_pending,
  // that placeholder was a legitimate-looking ±1 match candidate for any
  // unrelated real transaction one number away — this pins the fix for both
  // the seed side and the candidate side of that false-pair risk.
  it("never pairs a still-pending row carrying the 6098 placeholder, even against an otherwise-perfect ±1 match", () => {
    const handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    try {
      const checkingId = newAccount(handle.db, "Checking", "checking");
      const savingsId = newAccount(handle.db, "Savings", "savings");

      // A pending deposit (Star One's shared 6098 placeholder), inserted
      // first. It is the seed row for its own batch's linkTransferPairs call.
      const pendingResult = commitImport(
        {
          accountId: checkingId,
          filename: "checking-pending.csv",
          csvText: starOneCsv([
            { txn: "6098", date: "04/20/2026", memo: "   PENDING DEPOSIT", amount: 25, balance: 0 },
          ]),
        },
        handle.db,
      );
      if (pendingResult.status !== "committed") throw new Error("expected commit");
      expect(pendingResult.pairsLinked).toBe(0);

      // An unrelated, already-posted, real withdrawal on a different account,
      // same date, same |amount|, opposite sign, and a real bank transaction
      // number exactly one off from the placeholder (6099 vs 6098) — every
      // signal findTransferPairs uses lines up except that one leg is still
      // pending. This commit re-checks the pending row too, since it shares
      // the date with this batch's own new insert.
      const unrelatedResult = commitImport(
        {
          accountId: savingsId,
          filename: "savings-unrelated.csv",
          csvText: starOneCsv([
            { txn: "6099", date: "04/20/2026", memo: "UNRELATED WITHDRAWAL", amount: -25, balance: 975 },
          ]),
        },
        handle.db,
      );
      if (unrelatedResult.status !== "committed") throw new Error("expected commit");
      expect(unrelatedResult.pairsLinked).toBe(0);

      const rows = handle.db.select().from(schema.transactions).all();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.transferPairId === null)).toBe(true);
    } finally {
      handle.close();
    }
  });

  // Codex adversarial review (`/ship` 2026-09-04) flagged that filtering
  // isPending on BOTH queries (not just sameDayUnpaired) would make a
  // pending-only import return 0 before ever scanning its date — losing the
  // only mechanism that re-checks a date once its own legs' original imports
  // failed to pair them (e.g. two rows manually unlinked via "Not a
  // transfer"). newRows deliberately does NOT filter isPending so this
  // repair trigger survives; only sameDayUnpaired does, which is already
  // sufficient to keep the pending row itself from ever becoming a pair
  // member (see the test above).
  it("a pending row's import still triggers repair-linking of two unrelated already-posted, previously-unpaired rows sharing its date", () => {
    const handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    try {
      const checkingId = newAccount(handle.db, "Checking", "checking");
      const savingsId = newAccount(handle.db, "Savings", "savings");
      const otherId = newAccount(handle.db, "Other", "checking");

      // Two real legs that DO auto-link on arrival...
      commitImport(
        {
          accountId: checkingId,
          filename: "checking.csv",
          csvText: starOneCsv([
            { txn: "7001", date: "04/22/2026", memo: "TRANSFER TO SAVINGS", amount: -50, balance: 950 },
          ]),
        },
        handle.db,
      );
      const savingsResult = commitImport(
        {
          accountId: savingsId,
          filename: "savings.csv",
          csvText: starOneCsv([
            { txn: "7002", date: "04/22/2026", memo: "TRANSFER FROM CHECKING", amount: 50, balance: 1050 },
          ]),
        },
        handle.db,
      );
      if (savingsResult.status !== "committed") throw new Error("expected commit");
      expect(savingsResult.pairsLinked).toBe(1);
      const [legA, legB] = handle.db.select().from(schema.transactions).all();
      expect(legA.transferPairId).not.toBeNull();

      // ...then land back in an unpaired state WITHOUT going through
      // unlinkTransferPair (which now also stamps transferRejectedAt — see
      // the "never re-pairs a rejected pair" test below). This simulates a
      // historical gap instead: e.g. rows imported before this pairing logic
      // existed, or a `transferPairId` cleared by some other pre-existing
      // path, never an explicit "Not a transfer" rejection.
      handle.db
        .update(schema.transactions)
        .set({ transferPairId: null })
        .where(inArray(schema.transactions.id, [legA.id, legB.id]))
        .run();
      const afterUnlink = handle.db.select().from(schema.transactions).all();
      expect(afterUnlink.every((r) => r.transferPairId === null)).toBe(true);

      // An unrelated PENDING row lands on the SAME date, in a THIRD account.
      // It cannot itself pair with anything (still pending), but its import
      // should still re-scan 04/22/2026 and repair legA/legB.
      const repairResult = commitImport(
        {
          accountId: otherId,
          filename: "other-pending.csv",
          csvText: starOneCsv([
            { txn: "6098", date: "04/22/2026", memo: "   PENDING DEPOSIT", amount: 10, balance: 0 },
          ]),
        },
        handle.db,
      );
      if (repairResult.status !== "committed") throw new Error("expected commit");
      expect(repairResult.pairsLinked).toBe(1);

      const finalRows = handle.db.select().from(schema.transactions).all();
      const [finalLegA, finalLegB, finalPending] = [
        finalRows.find((r) => r.id === legA.id)!,
        finalRows.find((r) => r.id === legB.id)!,
        finalRows.find((r) => r.accountId === otherId)!,
      ];
      expect(finalLegA.transferPairId).toBe(finalLegB.id);
      expect(finalLegB.transferPairId).toBe(finalLegA.id);
      expect(finalPending.transferPairId).toBeNull();
    } finally {
      handle.close();
    }
  });

  // Red Team (`/ship` 2026-09-04) found that the repair scan above (a
  // legitimate self-heal for a historical gap) also silently reverses an
  // EXPLICIT "Not a transfer" correction, because transferPairId IS NULL was
  // the only eligibility signal and unlinkTransferPair set nothing else.
  // Fix: unlinkTransferPair now also stamps transferRejectedPartnerId on
  // both legs (pointed at each other), and linkTransferPairs filters its
  // PROPOSED pairs against it — pair-scoped, not transaction-scoped (a
  // transaction-scoped version was tried first and reverted per Codex
  // structured review; see the next test for exactly the scenario that
  // caught).
  it("never re-pairs two rows the user explicitly rejected via unlinkTransferPair, even when an unrelated import re-scans their date", () => {
    const handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    try {
      const checkingId = newAccount(handle.db, "Checking", "checking");
      const savingsId = newAccount(handle.db, "Savings", "savings");
      const otherId = newAccount(handle.db, "Other", "checking");

      commitImport(
        {
          accountId: checkingId,
          filename: "checking.csv",
          csvText: starOneCsv([
            { txn: "7101", date: "04/25/2026", memo: "TRANSFER TO SAVINGS", amount: -60, balance: 940 },
          ]),
        },
        handle.db,
      );
      const savingsResult = commitImport(
        {
          accountId: savingsId,
          filename: "savings.csv",
          csvText: starOneCsv([
            { txn: "7102", date: "04/25/2026", memo: "TRANSFER FROM CHECKING", amount: 60, balance: 1060 },
          ]),
        },
        handle.db,
      );
      if (savingsResult.status !== "committed") throw new Error("expected commit");
      expect(savingsResult.pairsLinked).toBe(1);
      const [legA, legB] = handle.db.select().from(schema.transactions).all();

      // User decides this was a coincidental ±1 match, not a real transfer,
      // and clicks "Not a transfer".
      unlinkTransferPair(legA.id, handle.db);
      const rejected = handle.db
        .select()
        .from(schema.transactions)
        .where(eq(schema.transactions.id, legA.id))
        .get()!;
      expect(rejected.transferPairId).toBeNull();
      expect(rejected.transferRejectedPartnerId).toBe(legB.id);

      // An unrelated PENDING row lands on the SAME date, in a THIRD account —
      // structurally identical to the repair scenario above, except this pair
      // was REJECTED, not just historically unpaired.
      const laterResult = commitImport(
        {
          accountId: otherId,
          filename: "other-pending.csv",
          csvText: starOneCsv([
            { txn: "6098", date: "04/25/2026", memo: "   PENDING DEPOSIT", amount: 10, balance: 0 },
          ]),
        },
        handle.db,
      );
      if (laterResult.status !== "committed") throw new Error("expected commit");
      expect(laterResult.pairsLinked).toBe(0);

      const finalRows = handle.db.select().from(schema.transactions).all();
      const [finalLegA, finalLegB] = [
        finalRows.find((r) => r.id === legA.id)!,
        finalRows.find((r) => r.id === legB.id)!,
      ];
      expect(finalLegA.transferPairId).toBeNull();
      expect(finalLegB.transferPairId).toBeNull();
    } finally {
      handle.close();
    }
  });

  // Codex structured review (`/ship` 2026-09-04) caught the flaw in a
  // transaction-scoped rejection marker: rejecting one false-positive pair
  // would permanently block that row from ever pairing with its ACTUAL
  // correct counterpart too — an ordinary correction became unrecoverable.
  // The pair-scoped fix (transferRejectedPartnerId) must not have this
  // problem: legA's real transfer leg should still auto-link normally after
  // legA was rejected against a DIFFERENT, coincidentally-matching row.
  it("a row rejected against one false-positive match can still auto-pair with its real counterpart", () => {
    const handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    try {
      const checkingId = newAccount(handle.db, "Checking", "checking");
      const decoyId = newAccount(handle.db, "Decoy", "savings");
      const realId = newAccount(handle.db, "Real", "savings");

      // legA and a coincidental ±1 match on Decoy — a false positive.
      commitImport(
        {
          accountId: checkingId,
          filename: "checking.csv",
          csvText: starOneCsv([
            { txn: "8001", date: "04/28/2026", memo: "WITHDRAWAL", amount: -75, balance: 925 },
          ]),
        },
        handle.db,
      );
      const decoyResult = commitImport(
        {
          accountId: decoyId,
          filename: "decoy.csv",
          csvText: starOneCsv([
            { txn: "8002", date: "04/28/2026", memo: "UNRELATED DEPOSIT", amount: 75, balance: 575 },
          ]),
        },
        handle.db,
      );
      if (decoyResult.status !== "committed") throw new Error("expected commit");
      expect(decoyResult.pairsLinked).toBe(1);
      const [legA, decoyLeg] = handle.db.select().from(schema.transactions).all();

      // User realizes this was a coincidence, not a real transfer, and rejects it.
      unlinkTransferPair(legA.id, handle.db);

      // legA's REAL transfer leg arrives later, in a different account —
      // txn 8000, exactly ±1 from legA's 8001 (8002 is already spoken for
      // by the rejected decoy pairing).
      const realResult = commitImport(
        {
          accountId: realId,
          filename: "real.csv",
          csvText: starOneCsv([
            { txn: "8000", date: "04/28/2026", memo: "TRANSFER FROM CHECKING", amount: 75, balance: 1075 },
          ]),
        },
        handle.db,
      );
      if (realResult.status !== "committed") throw new Error("expected commit");
      // legA must still be eligible to auto-pair with its real counterpart —
      // being rejected against decoyLeg must not have blacklisted legA outright.
      expect(realResult.pairsLinked).toBe(1);

      const finalRows = handle.db.select().from(schema.transactions).all();
      const finalLegA = finalRows.find((r) => r.id === legA.id)!;
      const realLeg = finalRows.find((r) => r.accountId === realId)!;
      const finalDecoyLeg = finalRows.find((r) => r.id === decoyLeg.id)!;
      expect(finalLegA.transferPairId).toBe(realLeg.id);
      expect(realLeg.transferPairId).toBe(finalLegA.id);
      // The decoy stays unpaired — legA didn't drag it along.
      expect(finalDecoyLeg.transferPairId).toBeNull();
    } finally {
      handle.close();
    }
  });
});

describe("commitImport — anchor edges", () => {
  let handle: TestDbHandle;
  let accountId: number;

  beforeEach(() => {
    handle = createTestDb();
    createSnapshotMock.mockClear();
    createSnapshotMock.mockReturnValue({
      snapshotPath: "/tmp/money.db.pre-import-TEST",
      timestamp: "TEST",
      consistent: true,
      degradedReason: null,
    });
    const [account] = handle.db
      .insert(schema.accounts)
      .values({
        name: "Checking",
        type: "checking",
        startingBalanceCents: 0,
        startingBalanceDate: "2026-01-01",
      })
      .returning()
      .all();
    accountId = account.id;
  });

  afterEach(() => {
    handle.close();
  });

  function account() {
    const [a] = handle.db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .all();
    return a;
  }

  // Known and deliberate, pinned so it is a decision rather than an accident:
  // the all-duplicate short-circuit returns before `createSnapshot` AND before
  // `anchorStartingBalance`, so a re-export carrying a strictly better (later)
  // anchor does not move it if every row in it is already in the ledger.
  it("skips the anchor write — and the snapshot — when every row is a duplicate", () => {
    commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );
    expect(account().startingBalanceDate).toBe("2026-04-16");
    createSnapshotMock.mockClear();

    // GAS alone: a different row index, so its hash differs and the content
    // pass catches it. Nothing new to insert, but the file on its own would
    // derive the later, strictly safer anchor 2026-04-17 / 94790.
    const result = commitImport(
      { accountId, filename: "gas-only.csv", csvText: starOneCsv([GAS]) },
      handle.db,
    );

    expect(result.status).toBe("empty");
    if (result.status !== "empty") throw new Error("unreachable");
    expect(result.duplicateCount).toBe(1);
    expect(createSnapshotMock).not.toHaveBeenCalled();
    expect(account().startingBalanceDate).toBe("2026-04-16");
    expect(account().startingBalanceCents).toBe(100000);
  });

  // Pending rows are excluded from the chain, and `parseCsv` flags a `6098`
  // row with a 0 balance as pending — a non-null 0 that would break the chain
  // outright if the filter keyed on the balance column alone.
  it("excludes a pending row carrying a 0 balance from the chain", () => {
    const pending = {
      txn: "6098",
      date: "04/19/2026",
      memo: "PENDING DEPOSIT",
      amount: 25,
      balance: 0,
    };
    const result = commitImport(
      { accountId, filename: "pending.csv", csvText: starOneCsv([COFFEE, GAS, pending]) },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.startingBalance).toEqual({
      date: "2026-04-16",
      startingBalanceCents: 100000,
    });

    const [pendingRow] = handle.db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.isPending, true))
      .all();
    expect(pendingRow.balanceCents).toBe(0);
  });

  it("does not let a pending row inflate the computed balance past the bank's posted balance", () => {
    const pending = {
      txn: "6098",
      date: "04/19/2026",
      memo: "PENDING DEPOSIT",
      amount: 25,
      balance: 0,
    };
    commitImport(
      { accountId, filename: "pending.csv", csvText: starOneCsv([COFFEE, GAS, pending]) },
      handle.db,
    );

    // 94790 is the file's last POSTED running balance (GAS's 947.90) — what
    // the bank reports as `balance` and what /sync's drift check compares
    // against. Including the +$25 pending deposit would overshoot it.
    const [balance] = loadAccountBalances(handle.db);
    expect(balance.balanceCents).toBe(94790);
  });

  // The guard is `derived.date < account.startingBalanceDate`, not `<=`: an
  // anchor on the same date is refreshed, which matters when a later export
  // reveals a same-day row that was missing when the anchor was first set.
  it("refreshes the anchor when a later export changes its own date's close", () => {
    commitImport(
      { accountId, filename: "first.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );
    expect(account().startingBalanceCents).toBe(100000);

    // A same-day row that the first export missed, so 04/16 now closes 20.00
    // lower and every downstream balance shifts with it.
    const lateSameDay = {
      txn: "1001b",
      date: "04/16/2026",
      memo: "ATM WITHDRAWAL",
      amount: -20,
      balance: 980,
    };
    const result = commitImport(
      {
        accountId,
        filename: "corrected.csv",
        csvText: starOneCsv([COFFEE, lateSameDay, { ...GAS, balance: 927.9 }]),
      },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.insertedCount).toBe(1);
    expect(account().startingBalanceDate).toBe("2026-04-16");
    expect(account().startingBalanceCents).toBe(98000);
    expect(loadAccountBalances(handle.db)[0].balanceCents).toBe(92790);
  });
});
