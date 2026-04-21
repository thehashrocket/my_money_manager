CREATE TABLE `subscription_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`normalized_merchant` text NOT NULL,
	`dismissed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_dismissals_merchant_unique` ON `subscription_dismissals` (`normalized_merchant`);