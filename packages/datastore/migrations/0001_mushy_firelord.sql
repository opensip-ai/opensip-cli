CREATE TABLE `graph_baseline_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_baseline_signals` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`captured_at` integer NOT NULL
);
