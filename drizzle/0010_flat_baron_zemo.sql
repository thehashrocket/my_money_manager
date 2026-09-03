-- Hand-edited from drizzle-kit's raw generated output: the INSERT below
-- must SELECT the OLD "filename" column, not "label" -- "label" does not
-- exist on `import_batches` until this same statement creates it via
-- __new_import_batches, so a naive regeneration that copies "label" instead
-- throws `no such column: label` against any non-empty database. Covered by
-- src/db/migration0010.test.ts's first describe block. If you regenerate
-- this file with `pnpm db:generate`, verify the INSERT still reads
-- "filename" before committing.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`label` text,
	`imported_at` integer DEFAULT (unixepoch()) NOT NULL,
	`transaction_count` integer DEFAULT 0 NOT NULL,
	`snapshot_path` text,
	`snapshot_warning` text
);
--> statement-breakpoint
INSERT INTO `__new_import_batches`("id", "source", "label", "imported_at", "transaction_count", "snapshot_path", "snapshot_warning") SELECT "id", "source", CASE WHEN "source" = 'simplefin' THEN NULL ELSE "filename" END, "imported_at", "transaction_count", "snapshot_path", "snapshot_warning" FROM `import_batches`;--> statement-breakpoint
DROP TABLE `import_batches`;--> statement-breakpoint
ALTER TABLE `__new_import_batches` RENAME TO `import_batches`;--> statement-breakpoint
PRAGMA foreign_keys=ON;