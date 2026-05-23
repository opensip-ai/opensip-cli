CREATE TABLE `session_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`check_slug` text NOT NULL,
	`passed` integer NOT NULL,
	`violation_count` integer,
	`duration_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_checks_session_idx` ON `session_checks` (`session_id`);--> statement-breakpoint
CREATE TABLE `session_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_check_id` integer NOT NULL,
	`rule_id` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`file_path` text,
	`line` integer,
	`column` integer,
	`suggestion` text,
	`category` text,
	FOREIGN KEY (`session_check_id`) REFERENCES `session_checks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_findings_check_idx` ON `session_findings` (`session_check_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`timestamp` integer NOT NULL,
	`cwd` text NOT NULL,
	`recipe` text,
	`score` integer NOT NULL,
	`passed` integer NOT NULL,
	`summary` text NOT NULL,
	`duration_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_tool_timestamp_idx` ON `sessions` (`tool`,"timestamp" DESC);