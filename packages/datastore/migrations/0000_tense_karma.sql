CREATE TABLE `session_host_metrics` (
	`session_id` text PRIMARY KEY NOT NULL,
	`tty_busy_ms` integer,
	`render_ms` integer,
	`persist_ms` integer,
	`egress_ms` integer,
	`total_command_ms` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_tool_payload` (
	`session_id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`payload` text NOT NULL,
	`payload_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`timestamp` integer NOT NULL,
	`timestamp_iso` text,
	`completed_at` integer,
	`completed_at_iso` text,
	`cwd` text NOT NULL,
	`recipe` text,
	`score` integer NOT NULL,
	`passed` integer NOT NULL,
	`duration_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_tool_timestamp_idx` ON `sessions` (`tool`,"timestamp" DESC);--> statement-breakpoint
CREATE TABLE `graph_catalog` (
	`id` integer PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`cache_key` text NOT NULL,
	`files_fingerprint` text NOT NULL,
	`built_at` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graph_shard_fragment` (
	`shard_id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`cache_key` text NOT NULL,
	`shard_fingerprint` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_baseline_entries` (
	`tool` text NOT NULL,
	`stable_id` text,
	`fingerprint` text NOT NULL,
	`payload` text,
	`captured_at` integer NOT NULL,
	PRIMARY KEY(`tool`, `fingerprint`)
);
--> statement-breakpoint
CREATE TABLE `tool_baseline_meta` (
	`tool` text PRIMARY KEY NOT NULL,
	`stable_id` text,
	`captured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_state` (
	`tool` text NOT NULL,
	`stable_id` text,
	`key` text NOT NULL,
	`payload` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tool`, `key`)
);
