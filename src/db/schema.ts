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

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: ["checking", "savings"] }).notNull(),
  startingBalanceCents: integer("starting_balance_cents").notNull(),
  startingBalanceDate: text("starting_balance_date").notNull(),
  createdAt,
  updatedAt,
});

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
    index("category_rules_priority_idx").on(t.priority),
    index("category_rules_match_value_idx").on(t.matchValue),
  ],
);

export const importBatches = sqliteTable("import_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source", { enum: ["csv", "simplefin"] }).notNull(),
  filename: text("filename").notNull(),
  importedAt: integer("imported_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  transactionCount: integer("transaction_count").notNull().default(0),
  snapshotPath: text("snapshot_path"),
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
    amountCents: integer("amount_cents").notNull(),
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
