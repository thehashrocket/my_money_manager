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
-- WHY THE JOIN IS EXACT HERE, and where the argument stops. It resolves
-- provenance through `accounts.simplefin_account_id`, i.e. where the account
-- points NOW, which is normally the wrong question — the whole reason this
-- column exists is that a link can move. It is exact for this ledger because of
-- what the old code did: a re-point or unlink CLEARED `external_id` on that
-- account's rows, so a row that still carries an external_id had not been
-- through a relink, and its account's current link is the feed it came from.
-- The `WHERE external_id IS NOT NULL` clause is what carries that argument, and
-- it is why nothing after the fact can repair a row already stripped by a
-- pre-fix relink.
--
-- That argument is NOT universal, and the limit is worth stating rather than
-- glossing: `setAccountLink` only began clearing external_id in v0.8.3
-- (ca53e68, 2026-09-02 18:37), roughly five hours after sync itself shipped in
-- v0.8.0 (28aa181, 13:45) with a link path that wrote nothing but
-- `accounts.simplefin_account_id`. A re-point in that window leaves rows
-- carrying an external_id whose account has since moved, and for those the join
-- resolves to whatever the account points at now — a WRONG tag, not a NULL one.
--
-- Verified rather than assumed, immediately before applying this migration:
--
--   rows with external_id, account linked ....... 35  (24 on ACT-d326a3ba,
--                                                      11 on ACT-bb8ad7b1)
--   rows with external_id, account UNLINKED ..... 0
--   sync rows total ............................. 35   (0 untagged)
--   csv rows ................................... 1527  (all external_id NULL)
--
-- Zero ambiguous rows, so the backfill is exact on this ledger. Re-run that
-- check before applying to any other one.
--
-- Ordering matters: the backfill runs BEFORE the new unique index is created,
-- so the index is built over final data and a genuine (feed, id) collision
-- fails the migration loudly instead of being silently permitted by NULL
-- distinctness and surfacing later as a re-import.
--
-- Not handled HERE, but no longer merely argued away: a row with an external_id
-- whose account has NULL `simplefin_account_id` backfills to NULL, and an
-- untagged row carrying an external_id is invisible to both dedup passes and to
-- the unique index (NULLs distinct), so it would re-import on every sync. That
-- state is empty above, but an unlink on /sync is one click and this migration
-- had not yet run — so `syncSimpleFin`'s content-dedup candidacy now admits
-- `simplefin_source_account_id IS NULL` as its own case, which makes the class
-- safe however it arose. See case 3 in src/lib/simplefin/sync.ts, covered by
-- tests in src/lib/simplefin/sync.test.ts.
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
