-- HAND-EDITED after `drizzle-kit generate`. The generated file had the three
-- schema statements below but no BACKFILL, and the backfill is load-bearing
-- rather than cosmetic:
--
--   The new unique index is over (simplefin_source_account_id, external_id).
--   SQLite treats NULLs as DISTINCT in a unique index, so leaving the new
--   column NULL on existing rows does not merely lose tidiness — it defeats
--   the index for every one of them. Worse, `syncSimpleFin`'s id pass keys on
--   `simplefin_source_account_id = <feed>`, which no NULL row matches, and the
--   content-dedup fallback excludes them too (they carry an external_id, and
--   `NULL <> '<feed>'` is NULL, not true). Every already-imported sync row
--   would look brand new on the very next sync and be inserted a second time.
--   That is the exact double-count this migration exists to remove.
--
-- WHY THE JOIN IS EXACT, not a best guess. It resolves provenance through
-- `accounts.simplefin_account_id`, i.e. where the account points NOW, which is
-- normally the wrong question — the whole reason this column exists is that a
-- link can move. It is exact HERE because of what the old code did: a re-point
-- or unlink CLEARED `external_id` on that account's rows. So a row that still
-- carries an external_id has, by construction, never been through a relink, and
-- its account's current link is necessarily the feed it came from. The
-- `WHERE external_id IS NOT NULL` clause is what makes that argument hold, and
-- it is why this migration can be exact while nothing after the fact could
-- repair a row already stripped by a pre-fix relink.
--
-- Ordering matters: the backfill runs BEFORE the new unique index is created,
-- so the index is built over final data and a genuine (feed, id) collision
-- fails the migration loudly instead of being silently permitted by NULL
-- distinctness and surfacing later as a re-import.
--
-- Left deliberately unhandled: a row with an external_id whose account has NULL
-- `simplefin_account_id`. Unreachable by the argument above (unlinking cleared
-- the tag), and pinned by a test in src/lib/simplefin/sync.test.ts rather than
-- guarded here.
DROP INDEX `transactions_account_external_id_unique`;--> statement-breakpoint
ALTER TABLE `transactions` ADD `simplefin_source_account_id` text;--> statement-breakpoint
UPDATE `transactions`
SET `simplefin_source_account_id` = (
  SELECT `accounts`.`simplefin_account_id`
  FROM `accounts`
  WHERE `accounts`.`id` = `transactions`.`account_id`
)
WHERE `external_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_feed_external_id_unique` ON `transactions` (`simplefin_source_account_id`,`external_id`) WHERE "transactions"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `transactions_feed_source_idx` ON `transactions` (`simplefin_source_account_id`);
