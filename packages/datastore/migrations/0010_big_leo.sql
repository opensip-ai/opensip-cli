CREATE TABLE `graph_context_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`schema_version` integer NOT NULL,
	`producer_version` text NOT NULL,
	`created_at` text NOT NULL,
	`source_identity` text NOT NULL,
	`config_identity` text NOT NULL,
	`byte_count` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `graph_context_snapshot_kind_created_idx` ON `graph_context_snapshot` (`kind`,"created_at" DESC,"id" DESC);--> statement-breakpoint
CREATE INDEX `graph_context_snapshot_created_idx` ON `graph_context_snapshot` ("created_at" DESC,"id" DESC);--> statement-breakpoint
ALTER TABLE `runs` ADD `context_manifest` text;--> statement-breakpoint
CREATE INDEX `runs_cwd_name_completed_at_idx` ON `runs` (`cwd`,`name`,"completed_at" DESC);