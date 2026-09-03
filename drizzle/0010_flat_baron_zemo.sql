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