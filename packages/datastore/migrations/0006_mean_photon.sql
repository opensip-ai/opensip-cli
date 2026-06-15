CREATE TABLE `tool_baseline_entries` (
	`tool` text NOT NULL,
	`fingerprint` text NOT NULL,
	`payload` text,
	`captured_at` integer NOT NULL,
	PRIMARY KEY(`tool`, `fingerprint`)
);
--> statement-breakpoint
CREATE TABLE `tool_baseline_meta` (
	`tool` text PRIMARY KEY NOT NULL,
	`captured_at` integer NOT NULL
);
