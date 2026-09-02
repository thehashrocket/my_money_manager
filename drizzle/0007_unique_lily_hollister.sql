ALTER TABLE `accounts` ADD `simplefin_account_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_simplefin_account_id_unique` ON `accounts` (`simplefin_account_id`) WHERE "accounts"."simplefin_account_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `external_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_account_external_id_unique` ON `transactions` (`account_id`,`external_id`) WHERE "transactions"."external_id" IS NOT NULL;