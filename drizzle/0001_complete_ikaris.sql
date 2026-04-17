ALTER TABLE `budget_periods` ADD `effective_allocation_cents` integer;--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`name`, `carryover_policy`) VALUES ('Uncategorized', 'none');--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`name`, `carryover_policy`) VALUES ('Groceries', 'none');--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`name`, `carryover_policy`) VALUES ('Gas', 'none');--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`name`, `carryover_policy`) VALUES ('Dining', 'none');--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`name`, `carryover_policy`) VALUES ('Utilities', 'none');--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`name`, `carryover_policy`) VALUES ('Misc', 'none');--> statement-breakpoint
CREATE TRIGGER `categories_uncategorized_no_delete` BEFORE DELETE ON `categories` FOR EACH ROW WHEN OLD.name = 'Uncategorized' BEGIN SELECT RAISE(ABORT, 'Cannot delete the Uncategorized category'); END;
