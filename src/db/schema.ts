import { sql, relations } from "drizzle-orm";
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  index,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

const createdAt = integer("created_at", { mode: "timestamp" })
  .notNull()
  .default(sql`(unixepoch())`);

const updatedAt = integer("updated_at", { mode: "timestamp" })
  .notNull()
  .default(sql`(unixepoch())`);

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    // `credit` and `loan` were added by migration 0018. There is no CHECK
    // constraint on this column anywhere in drizzle/ — the enum is a
    // TypeScript-level fiction — so widening it needed no SQL. Read the
    // asset/liability split through `accountClass(type)`, never by comparing
    // the string here: a derived function can't disagree with itself the way
    // a second stored column could (failure mode F6).
    type: text("type", { enum: ["checking", "savings", "credit", "loan"] }).notNull(),
    // A LIABILITY'S BALANCE IS STORED NEGATIVE. Owing $2,000 on a card is
    // -200000. A charge is negative, a payment is positive. Not a style
    // choice: it keeps rule 1's balance sum, rule 4's transfer-pair
    // definition, every `transfer_pair_id IS NULL` spend filter and
    // formatCents' accounting parens all working unchanged.
    startingBalanceCents: integer("starting_balance_cents").notNull(),
    startingBalanceDate: text("starting_balance_date").notNull(),
    // Optional, credit cards only (D2=A): drives the utilization bar via
    // resolveUtilizationDisplay. NULL means "no utilization to show" and is
    // the normal state for a loan — but it must NOT be what decides the
    // muted long-term treatment, or a card added without a limit renders as
    // a mortgage (E7). That reads `isLongTermLiability(type)` instead.
    creditLimitCents: integer("credit_limit_cents"),
    // Static reference data you type once. Explicitly NOT tracked, not
    // reconciled, and never compared against payments actually made — that
    // distinction is why it dodges the "minimum-payment tracking is not V1"
    // exclusion rather than violating it. Cards only, per D2=A.
    minimumPaymentCents: integer("minimum_payment_cents"),
    // THE PROVIDER'S OWN `balance-date`, NOT when we fetched it (D15).
    // classifyBalanceFreshness exists precisely because a successful fetch
    // can still serve a stale provider snapshot; storing fetch time here
    // would mark a frozen balance as fresh. NULL after a manual reconcile —
    // resolveStalenessDisplay falls back to startingBalanceDate.
    balanceAsOf: integer("balance_as_of", { mode: "timestamp" }),
    // Which path last moved this account's anchor. HISTORY, not capability:
    // it feeds DS57's staleness threshold only (7 days for `feed`, 35 for
    // `manual`). What a row can DO is derived by resolveBalanceAction from
    // the feed link plus hasAnyTransactionRows, because asking one column
    // both questions left every freshly created card able to do neither (E4).
    // Set to 'manual' at account creation: a hand-typed balance owed IS a
    // manual reconcile, and 35 days is the right clock to start.
    balanceSource: text("balance_source", { enum: ["feed", "manual"] }),
    // The anchor immediately before the most recent move, same idea as
    // import_batches.prior_starting_balance_* but account-scoped: /sync's
    // liability balance pass and /accounts' Reconcile both move an anchor
    // with no import batch to hang the prior value on (D7, E19). This is
    // also the real mechanism /accounts/error.tsx reassures the user with —
    // no snapshot is taken for an anchor write, and claiming one would be a
    // false reassurance shown at the moment something broke.
    priorStartingBalanceCents: integer("prior_starting_balance_cents"),
    priorStartingBalanceDate: text("prior_starting_balance_date"),
    // SimpleFIN's opaque account id (e.g. "ACT-d326a3ba-..."). NULL means this
    // account is CSV-only and sync skips it — that is how the mortgage account
    // the feed also returns stays out of a checking/savings-only app.
    simplefinAccountId: text("simplefin_account_id"),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("accounts_simplefin_account_id_unique")
      .on(t.simplefinAccountId)
      .where(sql`${t.simplefinAccountId} IS NOT NULL`),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    parentId: integer("parent_id").references((): AnySQLiteColumn => categories.id, {
      onDelete: "set null",
    }),
    // 'income' | 'expense' | 'fund' — added by migration 0017. Backfilled from
    // name (Paycheck/Interest/Reimbursement -> income) and is_savings_goal
    // (true -> fund); everything else defaults to expense. is_savings_goal
    // stays a truthful shadow (createGoalAction dual-writes it) until PR3
    // drops it — see CLAUDE.md rule 6 and TODOS.md.
    kind: text("kind", { enum: ["income", "expense", "fund"] })
      .notNull()
      .default("expense"),
    // Backfilled alphabetically within each parent by migration 0017.
    // Ordering only ever compares siblings sharing a parent_id — see the
    // migration's own comment for why the flat top level (10 group parents +
    // 3 income leaves + Uncategorized, all parent_id IS NULL) is safe.
    sortOrder: integer("sort_order").notNull().default(0),
    // Nullable, no backfill (migration 0017). Matches nothing until PR2b's
    // archiveCategoryAction exists.
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    isSavingsGoal: integer("is_savings_goal", { mode: "boolean" })
      .notNull()
      .default(false),
    targetCents: integer("target_cents"),
    carryoverPolicy: text("carryover_policy", {
      enum: ["none", "rollover", "reset"],
    })
      .notNull()
      .default("none"),
    createdAt,
    updatedAt,
  },
  (t) => [uniqueIndex("categories_name_unique").on(t.name)],
);

export const categoryRules = sqliteTable(
  "category_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    matchType: text("match_type", { enum: ["exact", "contains", "regex"] }).notNull(),
    matchValue: text("match_value").notNull(),
    priority: integer("priority").notNull().default(50),
    source: text("source", { enum: ["auto", "manual"] }).notNull(),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("category_rules_match_type_value_unique").on(t.matchType, t.matchValue),
    index("category_rules_priority_idx").on(t.priority),
    index("category_rules_match_value_idx").on(t.matchValue),
  ],
);

export const importBatches = sqliteTable("import_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // `manual` added by migration 0018 (D6=B). One batch per manual operation,
  // never one reused forever: every other column on this table is scoped to a
  // single atomic write, and reuse would freeze importedAt and permanently
  // falsify four of them (E21). deriveBatchLabel must handle it or every
  // batch-label render throws.
  source: text("source", { enum: ["csv", "simplefin", "manual"] }).notNull(),
  // The real uploaded filename for a CSV batch. Null for a sync batch — there
  // is no file, so display code derives a label from `source` + `importedAt`
  // instead of a synthetic string stored here (see deriveBatchLabel).
  label: text("label"),
  importedAt: integer("imported_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  transactionCount: integer("transaction_count").notNull().default(0),
  snapshotPath: text("snapshot_path"),
  // A general per-batch warning channel, despite the name: non-null when
  // createSnapshot() reported `consistent: false` for this batch's pre-write
  // snapshot (CLAUDE.md rule 5), OR when anchorStartingBalance declined to
  // move the account's anchor (CLAUDE.md rule 1) — the two reasons are joined
  // with a space if both fire. Persisted (not just redirected as a query
  // param) so the warning survives a later visit to this batch's success
  // page, not just the one right after commit. Do not treat a non-null value
  // here as meaning "this batch's snapshot specifically is unsafe to
  // restore" — check `snapshotPath`/the commit result's `snapshot.consistent`
  // for that.
  snapshotWarning: text("snapshot_warning"),
  // Non-null only when THIS batch moved the account's starting-balance anchor
  // (see anchorStartingBalance in importBatch.ts). Persisted rather than
  // re-derived from the account's current anchor for the same reason as
  // snapshotWarning above: a later import can move the anchor again, and a
  // live re-read would then misattribute the newer anchor to this batch's
  // success page on a revisit.
  anchoredStartingBalanceCents: integer("anchored_starting_balance_cents"),
  anchoredStartingBalanceDate: text("anchored_starting_balance_date"),
  // The account's anchor immediately before this batch moved it, captured in
  // the same write transaction as the move itself. `anchorStartingBalance`
  // (importBatch.ts) is the only writer of these two columns outside account
  // creation, and until this existed a bad automatic move had no record of
  // what to revert to — only a full snapshot restore. Null whenever this
  // batch didn't move the anchor.
  priorStartingBalanceCents: integer("prior_starting_balance_cents"),
  priorStartingBalanceDate: text("prior_starting_balance_date"),
  // How many transfer pairs `linkTransferPairs` actually linked as PART OF
  // this batch's commit — persisted rather than left for the success page to
  // recompute via `COUNT(*) WHERE import_batch_id = this batch`, because that
  // recompute silently undercounts: a pair can link a row that was updated
  // from pending to posted (`toUpdate` in `commitImport`), which keeps its
  // ORIGINAL batch's id, not this one. Null only for batches written before
  // this column existed; the success page falls back to the old (batch-id-
  // scoped, imprecise for toUpdate-linked pairs) query for those.
  pairsLinkedCount: integer("pairs_linked_count"),
});

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    date: text("date").notNull(),
    rawDescription: text("raw_description").notNull(),
    rawMemo: text("raw_memo").notNull(),
    normalizedMerchant: text("normalized_merchant").notNull(),
    // MX's cleaned merchant label ("Save Mart" vs the raw "SAVEMART MA
    // MANTECA"). Display only — categorization still keys on
    // normalized_merchant, so trained category_rules keep matching. NULL for
    // CSV rows, which have no such field.
    payee: text("payee"),
    amountCents: integer("amount_cents").notNull(),
    // Star One's running account balance immediately after this row, straight
    // from the CSV's Balance column. NULL on SimpleFIN rows (the feed reports a
    // balance per account, not per transaction), and NULL *or 0* on pending CSV
    // rows — Star One leaves the cell blank or zero until the row posts, and
    // parseCsv keys `isPending` on exactly that pair. Also NULL on any posted
    // row whose Balance cell does not parse. Derivation filters on `isPending`
    // first, so the 0 case never enters a chain. Not used for display:
    // it exists so an import can derive a real starting-balance anchor for the
    // account instead of leaving it at the fabricated 0 that makes every
    // displayed balance a net-change-since-signup figure.
    balanceCents: integer("balance_cents"),
    bankTransactionNumber: text("bank_transaction_number"),
    cardLastFour: text("card_last_four"),
    categoryId: integer("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    // `manual` added by migration 0018 — a hand-entered card charge, refund,
    // or payment mirror. Excluded from the automatic transfer matcher's
    // candidacy (D11): a manual row carries no bank_transaction_number, so
    // the cross-source guard never fires for it, and a $250 charge plus an
    // unrelated same-day $250 deposit is a balanced 1-and-1 bucket the
    // counting argument would auto-link without asking.
    importSource: text("import_source", { enum: ["csv", "simplefin", "manual"] }).notNull(),
    importBatchId: integer("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "restrict" }),
    importRowHash: text("import_row_hash").notNull(),
    // SimpleFIN's stable per-account transaction id. NULL for CSV rows. This is
    // a real primary key from the source, so it dedupes re-syncs exactly —
    // unlike import_row_hash, which needs a row index to break ties.
    externalId: text("external_id"),
    // WHICH FEED this row came from — `accounts.simplefin_account_id` as it stood
    // at import time, not a foreign key. NULL for CSV and manual rows.
    //
    // This is provenance, and it is deliberately NOT derivable from
    // `account_id`: a local account's link can be re-pointed, so joining through
    // `accounts` tells you where the account points NOW, never where a given row
    // actually came from. `setAccountLink` used to clear `external_id` on relink
    // to dodge a unique-index collision, and that erasure is what made the
    // cross-account double-count unfixable — sync could no longer tell one
    // account's feed rows from another's. Recording the feed is what lets the
    // clearing go away entirely.
    simplefinSourceAccountId: text("simplefin_source_account_id"),
    transferPairId: integer("transfer_pair_id").references(
      (): AnySQLiteColumn => transactions.id,
      { onDelete: "set null" },
    ),
    // A rejected pairing is NOT stored here. It used to be, as a single
    // `transfer_rejected_partner_id` column, and a column can hold exactly one
    // partner — see `transferPairRejections` below for why that turned out to
    // be unworkable rather than merely lossy.
    isPending: integer("is_pending", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("transactions_dedup_unique").on(
      t.accountId,
      t.importBatchId,
      t.importRowHash,
    ),
    index("transactions_date_idx").on(t.date),
    index("transactions_account_date_idx").on(t.accountId, t.date),
    index("transactions_category_idx").on(t.categoryId),
    index("transactions_merchant_idx").on(t.normalizedMerchant),
    // Scoped by FEED, not by local account. A SimpleFIN transaction id is unique
    // within its feed account, which is exactly what this index needs to assert;
    // `account_id` was only ever a proxy for it, and a wrong one the moment a
    // link moves. Scoping by the feed also means a re-point needs no data
    // rewrite at all: the rows keep both their id and their provenance, so the
    // next sync recognizes them wherever they happen to live.
    uniqueIndex("transactions_feed_external_id_unique")
      .on(t.simplefinSourceAccountId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    // Backs the per-feed dedup lookup in `syncSimpleFin`.
    index("transactions_feed_source_idx").on(t.simplefinSourceAccountId),
  ],
);

/**
 * "These two transactions are NOT two halves of one movement."
 *
 * PAIR-scoped, never transaction-scoped. A transaction-scoped flag was tried
 * first and reverted: rejecting one false-positive match permanently blocked
 * that row from pairing with its ACTUAL counterpart too, and the only UI that
 * could undo it was the review queue the same flag hid the row from.
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS A TABLE AND NOT A COLUMN                                  │
 * │                                                                       │
 * │ This started as `transactions.transfer_rejected_partner_id`, a single │
 * │ self-referencing column on each leg. That was documented as merely    │
 * │ LOSSY ("a row remembers only its most recent rejection"), on the      │
 * │ estimate that losing one needed four rejections across two rows. The  │
 * │ same-account reversal queue (v0.19.0) made writing a marker a ONE-    │
 * │ CLICK act, and two independent failures fell out of it immediately:   │
 * │                                                                       │
 * │  1. ERASURE. Rejecting (A,C) overwrites A's existing rejection of B.  │
 * │     Two clicks in the reversal queue can clear both legs of an        │
 * │     unrelated "Not a transfer", after which the automatic matcher     │
 * │     re-links the exact pair the user rejected — silently dropping     │
 * │     both rows out of every spend total.                               │
 * │                                                                       │
 * │  2. NON-CONVERGENCE. `findSameAccountReversals` drops a bucket only   │
 * │     once EVERY positive/negative combination is rejected. P·N         │
 * │     combinations compete for P+N column slots, so for P>=2 AND N>=2   │
 * │     the all-rejected state is UNREACHABLE — proved by exhaustive      │
 * │     search over the reachable state space, and live on the real       │
 * │     ledger (a 2x4 bucket, where 3 of 8 combinations stay live no      │
 * │     matter the click order). The queue could not be dismissed, and    │
 * │     said "this pairing won't be suggested again" every time.          │
 * │                                                                       │
 * │ Neither is fixable while one row holds one partner, so the store is   │
 * │ multi-valued. See `src/lib/transferRejections.ts`.                    │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * The pair is stored UNORDERED, normalised to `low < high`, so membership is
 * one exact index probe rather than the `a->b OR b->a` disjunction the column
 * needed. `onDelete: 'cascade'` mirrors the old column's `set null`: deleting
 * a transaction (an undone sync batch) takes its rejections with it.
 *
 * The automatic matchers consult this while PROPOSING each candidate pair,
 * never as select-time candidacy and never as a filter over a finished
 * result — so a rejected row stays eligible to match something else and only
 * this exact combination is blocked. `findAmbiguousTransfers` deliberately
 * does not filter its own SELECT on it either: a human reviewing that queue
 * is not a silent re-link.
 */
export const transferPairRejections = sqliteTable(
  "transfer_pair_rejections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** The smaller of the two transaction ids — see `normalizePairKey`. */
    lowTransactionId: integer("low_transaction_id")
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: "cascade" }),
    /** The larger of the two. `low < high` is enforced by `normalizePairKey`. */
    highTransactionId: integer("high_transaction_id")
      .notNull()
      .references((): AnySQLiteColumn => transactions.id, { onDelete: "cascade" }),
    createdAt,
  },
  (t) => [
    uniqueIndex("transfer_pair_rejections_unique").on(
      t.lowTransactionId,
      t.highTransactionId,
    ),
    // Both legs are looked up independently: a candidate pair arrives as
    // (a, b) in arbitrary order and the loader collects every rejection
    // touching a set of row ids.
    index("transfer_pair_rejections_low_idx").on(t.lowTransactionId),
    index("transfer_pair_rejections_high_idx").on(t.highTransactionId),
  ],
);

export const budgetPeriods = sqliteTable(
  "budget_periods",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    allocatedCents: integer("allocated_cents").notNull(),
    effectiveAllocationCents: integer("effective_allocation_cents"),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("budget_periods_category_year_month_unique").on(
      t.categoryId,
      t.year,
      t.month,
    ),
    index("budget_periods_year_month_idx").on(t.year, t.month),
  ],
);

export const accountsRelations = relations(accounts, ({ many }) => ({
  transactions: many(transactions),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: "category_parent",
  }),
  children: many(categories, { relationName: "category_parent" }),
  transactions: many(transactions),
  rules: many(categoryRules),
  budgetPeriods: many(budgetPeriods),
}));

export const categoryRulesRelations = relations(categoryRules, ({ one }) => ({
  category: one(categories, {
    fields: [categoryRules.categoryId],
    references: [categories.id],
  }),
}));

export const importBatchesRelations = relations(importBatches, ({ many }) => ({
  transactions: many(transactions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  account: one(accounts, {
    fields: [transactions.accountId],
    references: [accounts.id],
  }),
  category: one(categories, {
    fields: [transactions.categoryId],
    references: [categories.id],
  }),
  importBatch: one(importBatches, {
    fields: [transactions.importBatchId],
    references: [importBatches.id],
  }),
  transferPair: one(transactions, {
    fields: [transactions.transferPairId],
    references: [transactions.id],
    relationName: "transfer_pair",
  }),
}));

export const budgetPeriodsRelations = relations(budgetPeriods, ({ one }) => ({
  category: one(categories, {
    fields: [budgetPeriods.categoryId],
    references: [categories.id],
  }),
}));

// Records a row a trained rule categorized at import time (CSV or SimpleFIN),
// so that categorization — unlike a manual `bulkCategorize`, which has
// `undoBulkCategorize` — can still be reverted per batch. One row per
// transaction: a transaction is only ever rule-categorized once, at insert.
// `undoImportCategorization` deletes a batch's rows here once it has run, so
// their presence also means "this batch's auto-categorization is still
// revertible."
export const importBatchCategorizations = sqliteTable(
  "import_batch_categorizations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importBatchId: integer("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // The category the rule assigned. Compared against the transaction's
    // CURRENT category at undo time — a mismatch means the user categorized
    // it themselves since, and undo leaves it alone.
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    ruleId: integer("rule_id").references(() => categoryRules.id, {
      onDelete: "set null",
    }),
    createdAt,
  },
  (t) => [
    uniqueIndex("import_batch_categorizations_transaction_unique").on(t.transactionId),
    index("import_batch_categorizations_batch_idx").on(t.importBatchId),
  ],
);

export const importBatchCategorizationsRelations = relations(
  importBatchCategorizations,
  ({ one }) => ({
    importBatch: one(importBatches, {
      fields: [importBatchCategorizations.importBatchId],
      references: [importBatches.id],
    }),
    transaction: one(transactions, {
      fields: [importBatchCategorizations.transactionId],
      references: [transactions.id],
    }),
    category: one(categories, {
      fields: [importBatchCategorizations.categoryId],
      references: [categories.id],
    }),
    rule: one(categoryRules, {
      fields: [importBatchCategorizations.ruleId],
      references: [categoryRules.id],
    }),
  }),
);

export const subscriptionDismissals = sqliteTable(
  "subscription_dismissals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    normalizedMerchant: text("normalized_merchant").notNull(),
    dismissedAt: integer("dismissed_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("subscription_dismissals_merchant_unique").on(t.normalizedMerchant)],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type CategoryRule = typeof categoryRules.$inferSelect;
export type NewCategoryRule = typeof categoryRules.$inferInsert;
export type ImportBatch = typeof importBatches.$inferSelect;
export type NewImportBatch = typeof importBatches.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type BudgetPeriod = typeof budgetPeriods.$inferSelect;
export type NewBudgetPeriod = typeof budgetPeriods.$inferInsert;
export type SubscriptionDismissal = typeof subscriptionDismissals.$inferSelect;
export type NewSubscriptionDismissal = typeof subscriptionDismissals.$inferInsert;
export type ImportBatchCategorization = typeof importBatchCategorizations.$inferSelect;
export type NewImportBatchCategorization = typeof importBatchCategorizations.$inferInsert;
