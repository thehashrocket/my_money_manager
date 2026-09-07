-- 0018 — liability accounts (credit cards + the mortgage)
--
-- Six ADD COLUMNs and nothing else. The three enum widenings this feature
-- needs — accounts.type gaining 'credit'|'loan', import_batches.source and
-- transactions.import_source each gaining 'manual' — produce NO SQL and need
-- none: `type` is declared as bare `text NOT NULL` in 0000_thin_mandroid.sql
-- and there is not one CHECK constraint anywhere in drizzle/. Those enums are
-- TypeScript-level fictions enforced by Drizzle's type narrowing, not by
-- SQLite. Nothing here rebuilds a table, so this migration is safe under
-- drizzle-kit's single-transaction migrator (CLAUDE.md rule 7 applies to
-- rebuilds, not to ADD COLUMN).
--
-- All six columns are nullable with no default, so every existing row is
-- unaffected and no backfill is required: today's two accounts are both
-- assets, and an asset never reads any of them.

ALTER TABLE `accounts` ADD `credit_limit_cents` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `minimum_payment_cents` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `balance_as_of` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `balance_source` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `prior_starting_balance_cents` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `prior_starting_balance_date` text;