import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDbHandle } from "@/lib/test/db";
import { buildPreview, commitImport, transformRow } from "./importBatch";
import { computeImportRowHash } from "./hash";
import { loadAccountBalances } from "./accounts/loadAccountBalances";
import type { ParsedRow } from "./parseCsv";

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
    handle.db
      .insert(schema.categoryRules)
      .values({
        categoryId,
        matchType: "contains",
        matchValue: "STARBUCKS",
        source: "manual",
      })
      .run();

    commitImport(
      { accountId, filename: "a.csv", csvText: starOneCsv([COFFEE, GAS]) },
      handle.db,
    );

    const rows = committedRows();
    expect(
      rows.find((r) => r.normalizedMerchant === COFFEE_MERCHANT)?.categoryId,
    ).toBe(categoryId);
    expect(rows.find((r) => r.normalizedMerchant !== COFFEE_MERCHANT)?.categoryId)
      .toBeNull();
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

  it("leaves the anchor alone when the running balance does not chain", () => {
    const broken = starOneCsv([COFFEE, { ...GAS, balance: 88888 }]);
    const result = commitImport(
      { accountId, filename: "broken.csv", csvText: broken },
      handle.db,
    );

    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("unreachable");
    expect(result.startingBalance).toBeNull();
    expect(account().startingBalanceCents).toBe(0);
    expect(account().startingBalanceDate).toBe("2026-01-01");
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
