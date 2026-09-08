--> HAND-EDITED after `drizzle-kit generate`. Two deliberate changes, both
--> load-bearing; regenerating this file blindly will lose them.
-->
--> 1. DATA MIGRATION. This drops `transactions.transfer_rejected_partner_id`
-->    and replaces it with the `transfer_pair_rejections` table. The generated
-->    file rebuilds `transactions` (and so destroys the column) with no attempt
-->    to carry the rejections over. Every one of those rows is a correction the
-->    user made BY HAND — "these two are not a transfer" — and silently losing
-->    them re-arms the automatic matcher against exactly the pairings they
-->    already rejected. They are staged into a holding table below, before the
-->    rebuild, and replayed after it.
-->
--> 2. STATEMENT ORDER. The generated file creates `transfer_pair_rejections`
-->    FIRST, so its FOREIGN KEY references `transactions` across the window
-->    where the rebuild has done `DROP TABLE transactions` and not yet renamed
-->    `__new_transactions` into place. SQLite reparses the schema during
-->    `ALTER TABLE ... RENAME TO` and a foreign key pointing at a missing table
-->    is not reliably survivable there. Creating the table AFTER the rebuild
-->    means nothing ever references a table that doesn't exist.
-->
--> This is a table rebuild, so it must run via `pnpm db:migrate`
--> (`scripts/migrate.mjs`) and NOT `drizzle-kit migrate` — see CLAUDE.md rule 7.

--> Staging: no foreign keys, so it is unaffected by the rebuild below.
--> `MIN`/`MAX` normalise each pair to (low, high); both legs of a rejection
--> point at each other, so the pair is written twice and deduped on read-back.
CREATE TABLE `__rejection_backfill` (
	`low_transaction_id` integer NOT NULL,
	`high_transaction_id` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `__rejection_backfill` (`low_transaction_id`, `high_transaction_id`)
SELECT MIN(`id`, `transfer_rejected_partner_id`), MAX(`id`, `transfer_rejected_partner_id`)
FROM `transactions`
WHERE `transfer_rejected_partner_id` IS NOT NULL;--> statement-breakpoint

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`raw_description` text NOT NULL,
	`raw_memo` text NOT NULL,
	`normalized_merchant` text NOT NULL,
	`payee` text,
	`amount_cents` integer NOT NULL,
	`balance_cents` integer,
	`bank_transaction_number` text,
	`card_last_four` text,
	`category_id` integer,
	`import_source` text NOT NULL,
	`import_batch_id` integer NOT NULL,
	`import_row_hash` text NOT NULL,
	`external_id` text,
	`transfer_pair_id` integer,
	`is_pending` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`transfer_pair_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "account_id", "date", "raw_description", "raw_memo", "normalized_merchant", "payee", "amount_cents", "balance_cents", "bank_transaction_number", "card_last_four", "category_id", "import_source", "import_batch_id", "import_row_hash", "external_id", "transfer_pair_id", "is_pending", "notes", "created_at", "updated_at") SELECT "id", "account_id", "date", "raw_description", "raw_memo", "normalized_merchant", "payee", "amount_cents", "balance_cents", "bank_transaction_number", "card_last_four", "category_id", "import_source", "import_batch_id", "import_row_hash", "external_id", "transfer_pair_id", "is_pending", "notes", "created_at", "updated_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_dedup_unique` ON `transactions` (`account_id`,`import_batch_id`,`import_row_hash`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `transactions_merchant_idx` ON `transactions` (`normalized_merchant`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_account_external_id_unique` ON `transactions` (`account_id`,`external_id`) WHERE "transactions"."external_id" IS NOT NULL;--> statement-breakpoint

--> Created AFTER the rebuild, so its FOREIGN KEYs never reference a dropped table.
CREATE TABLE `transfer_pair_rejections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`low_transaction_id` integer NOT NULL,
	`high_transaction_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`low_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`high_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transfer_pair_rejections_unique` ON `transfer_pair_rejections` (`low_transaction_id`,`high_transaction_id`);--> statement-breakpoint
CREATE INDEX `transfer_pair_rejections_low_idx` ON `transfer_pair_rejections` (`low_transaction_id`);--> statement-breakpoint
CREATE INDEX `transfer_pair_rejections_high_idx` ON `transfer_pair_rejections` (`high_transaction_id`);--> statement-breakpoint

--> Replay. DISTINCT because both legs staged the same normalised pair.
INSERT OR IGNORE INTO `transfer_pair_rejections` (`low_transaction_id`, `high_transaction_id`)
SELECT DISTINCT `low_transaction_id`, `high_transaction_id` FROM `__rejection_backfill`;--> statement-breakpoint
DROP TABLE `__rejection_backfill`;
