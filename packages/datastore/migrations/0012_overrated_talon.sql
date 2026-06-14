CREATE TABLE `session_dashboard_contributions` (
	`session_id` text NOT NULL,
	`tool` text NOT NULL,
	`contribution` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`session_id`, `tool`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
ALTER TABLE `sessions` ADD `completed_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `completed_at_iso` text;