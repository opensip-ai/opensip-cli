CREATE TABLE `graph_baseline_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_baseline_signals` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_catalog` (
	`id` integer PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`cache_key` text NOT NULL,
	`files_fingerprint` text NOT NULL,
	`built_at` text NOT NULL,
	`payload` text NOT NULL
);
