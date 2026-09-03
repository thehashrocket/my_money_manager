CREATE TABLE `import_batch_categorizations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_batch_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`rule_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rule_id`) REFERENCES `category_rules`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_batch_categorizations_transaction_unique` ON `import_batch_categorizations` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `import_batch_categorizations_batch_idx` ON `import_batch_categorizations` (`import_batch_id`);