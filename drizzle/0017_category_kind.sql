ALTER TABLE `categories` ADD `kind` text DEFAULT 'expense' NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `archived_at` integer;--> statement-breakpoint
UPDATE `categories` SET `kind` = 'income' WHERE `name` IN ('Paycheck', 'Interest', 'Reimbursement');--> statement-breakpoint
UPDATE `categories` SET `kind` = 'fund' WHERE `is_savings_goal` = 1;--> statement-breakpoint
-- Capture which of the 10 canonical group names already exist BEFORE the
-- INSERT OR IGNORE below, so every reparent UPDATE can refuse to run for a
-- name that collided with a pre-existing user category (e.g. a savings goal
-- named "Travel"). Without this, `INSERT OR IGNORE` silently no-ops on the
-- collision and the reparent UPDATE below still matches the SELECT by name,
-- silently annexing the user's own row as a parent — dropping its money out
-- of every band total (it becomes a GROUP, and GROUPs never appear in
-- `loadMonthView`'s leaf lists).
CREATE TEMP TABLE `_migration_0017_group_preexisted` AS
  SELECT `name` FROM `categories` WHERE `name` IN
    ('Giving', 'Housing', 'Bills', 'Food', 'Transportation', 'Health', 'Family', 'Personal', 'Entertainment', 'Travel');--> statement-breakpoint
INSERT OR IGNORE INTO `categories` (`name`, `kind`, `sort_order`) VALUES
  ('Giving', 'expense', 1),
  ('Housing', 'expense', 2),
  ('Bills', 'expense', 3),
  ('Food', 'expense', 4),
  ('Transportation', 'expense', 5),
  ('Health', 'expense', 6),
  ('Family', 'expense', 7),
  ('Personal', 'expense', 8),
  ('Entertainment', 'expense', 9),
  ('Travel', 'expense', 10);--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Giving')
  WHERE `name` IN ('Gifts', 'Charity')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Giving');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Housing')
  WHERE `name` IN ('Rent', 'Home Maintenance', 'Renter''s Insurance', 'Home Goods')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Housing');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Bills')
  WHERE `name` IN ('Utilities', 'Electric', 'Water', 'Internet', 'Phone', 'Streaming', 'Software', 'News & Magazines', 'Subscriptions', 'Bank Fees')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Bills');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Food')
  WHERE `name` IN ('Groceries', 'Dining', 'Coffee', 'Fast Food', 'Alcohol')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Food');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Transportation')
  WHERE `name` IN ('Gas', 'Car Insurance', 'Car Maintenance', 'Parking', 'Rideshare', 'Public Transit')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Transportation');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Health')
  WHERE `name` IN ('Doctor', 'Dentist', 'Pharmacy', 'Health Insurance', 'Gym')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Health');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Family')
  WHERE `name` IN ('Childcare', 'School')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Family');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Personal')
  WHERE `name` IN ('Haircut', 'Clothing', 'Amazon', 'Electronics', 'ATM', 'Misc')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Personal');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Entertainment')
  WHERE `name` IN ('Movies & Events', 'Hobbies', 'Books & Music')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Entertainment');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Travel')
  WHERE `name` IN ('Hotels', 'Flights', 'Vacation')
    AND NOT EXISTS (SELECT 1 FROM `_migration_0017_group_preexisted` WHERE `name` = 'Travel');--> statement-breakpoint
DROP TABLE `_migration_0017_group_preexisted`;--> statement-breakpoint
UPDATE `categories` SET `sort_order` = (
  SELECT COUNT(*) FROM `categories` AS `sib`
   WHERE `sib`.`parent_id` IS `categories`.`parent_id`
     AND `sib`.`name` <= `categories`.`name`
) WHERE `parent_id` IS NOT NULL;--> statement-breakpoint
UPDATE `budget_periods` SET `effective_allocation_cents` = NULL;
