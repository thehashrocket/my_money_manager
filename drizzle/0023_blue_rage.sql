CREATE TABLE `sync_promotions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`prior_is_pending` integer NOT NULL,
	`prior_raw_memo` text NOT NULL,
	`prior_normalized_merchant` text NOT NULL,
	`prior_payee` text,
	`prior_card_last_four` text,
	`prior_import_row_hash` text NOT NULL,
	`prior_external_id` text,
	`prior_simplefin_source_account_id` text,
	`prior_bank_transaction_number` text,
	`prior_transfer_pair_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_promotions_transaction_unique` ON `sync_promotions` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `sync_promotions_batch_idx` ON `sync_promotions` (`batch_id`);