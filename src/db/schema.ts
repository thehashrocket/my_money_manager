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
    type: text("type", { enum: ["checking", "savings"] }).notNull(),
    startingBalanceCents: integer("starting_balance_cents").notNull(),
    startingBalanceDate: text("starting_balance_date").notNull(),
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
  source: text("source", { enum: ["csv", "simplefin"] }).notNull(),
  // The real uploaded filename for a CSV batch. Null for a sync batch — there
  // is no file, so display code derives a label from `source` + `importedAt`
  // instead of a synthetic string stored here (see deriveBatchLabel).
  label: text("label"),
  importedAt: integer("imported_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  transactionCount: integer("transaction_count").notNull().default(0),
  snapshotPath: text("snapshot_path"),
  // Non-null only when createSnapshot() reported `consistent: false` for this
  // batch's pre-write snapshot. Persisted (not just redirected as a query
  // param) so the warning survives a later visit to this batch's success
  // page, not just the one right after commit — CLAUDE.md rule 5 requires the
  // degraded flag never be silently dropped.
  snapshotWarning: text("snapshot_warning"),
  // Non-null only when THIS batch moved the account's starting-balance anchor
  // (see anchorStartingBalance in importBatch.ts). Persisted rather than
  // re-derived from the account's current anchor for the same reason as
  // snapshotWarning above: a later import can move the anchor again, and a
  // live re-read would then misattribute the newer anchor to this batch's
  // success page on a revisit.
  anchoredStartingBalanceCents: integer("anchored_starting_balance_cents"),
  anchoredStartingBalanceDate: text("anchored_starting_balance_date"),
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
    importSource: text("import_source", { enum: ["csv", "simplefin"] }).notNull(),
    importBatchId: integer("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "restrict" }),
    importRowHash: text("import_row_hash").notNull(),
    // SimpleFIN's stable per-account transaction id. NULL for CSV rows. This is
    // a real primary key from the source, so it dedupes re-syncs exactly —
    // unlike import_row_hash, which needs a row index to break ties.
    externalId: text("external_id"),
    transferPairId: integer("transfer_pair_id").references(
      (): AnySQLiteColumn => transactions.id,
      { onDelete: "set null" },
    ),
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
    uniqueIndex("transactions_account_external_id_unique")
      .on(t.accountId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
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
