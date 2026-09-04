ALTER TABLE `categories` ADD `kind` text DEFAULT 'expense' NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` ADD `archived_at` integer;--> statement-breakpoint
UPDATE `categories` SET `kind` = 'income' WHERE `name` IN ('Paycheck', 'Interest', 'Reimbursement');--> statement-breakpoint
UPDATE `categories` SET `kind` = 'fund' WHERE `is_savings_goal` = 1;--> statement-breakpoint
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
  WHERE `name` IN ('Gifts', 'Charity');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Housing')
  WHERE `name` IN ('Rent', 'Home Maintenance', 'Renter''s Insurance', 'Home Goods');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Bills')
  WHERE `name` IN ('Utilities', 'Electric', 'Water', 'Internet', 'Phone', 'Streaming', 'Software', 'News & Magazines', 'Subscriptions', 'Bank Fees');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Food')
  WHERE `name` IN ('Groceries', 'Dining', 'Coffee', 'Fast Food', 'Alcohol');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Transportation')
  WHERE `name` IN ('Gas', 'Car Insurance', 'Car Maintenance', 'Parking', 'Rideshare', 'Public Transit');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Health')
  WHERE `name` IN ('Doctor', 'Dentist', 'Pharmacy', 'Health Insurance', 'Gym');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Family')
  WHERE `name` IN ('Childcare', 'School');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Personal')
  WHERE `name` IN ('Haircut', 'Clothing', 'Amazon', 'Electronics', 'ATM', 'Misc');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Entertainment')
  WHERE `name` IN ('Movies & Events', 'Hobbies', 'Books & Music');--> statement-breakpoint
UPDATE `categories` SET `parent_id` = (SELECT `id` FROM `categories` WHERE `name` = 'Travel')
  WHERE `name` IN ('Hotels', 'Flights', 'Vacation');--> statement-breakpoint
UPDATE `categories` SET `sort_order` = (
  SELECT COUNT(*) FROM `categories` AS `sib`
   WHERE `sib`.`parent_id` IS `categories`.`parent_id`
     AND `sib`.`name` <= `categories`.`name`
) WHERE `parent_id` IS NOT NULL;--> statement-breakpoint
UPDATE `budget_periods` SET `effective_allocation_cents` = NULL;
