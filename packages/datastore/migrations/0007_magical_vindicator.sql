CREATE TABLE `run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`logical_step_key` text NOT NULL,
	`ordinal` integer NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`tool` text NOT NULL,
	`command` text NOT NULL,
	`stable_id` text NOT NULL,
	`effective_args` text,
	`exit_code` integer NOT NULL,
	`outcome` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`verdict_summary` text,
	`session_id` text,
	`evidence` text,
	`parent_step_id` text,
	`dependency` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `run_steps_run_order_idx` ON `run_steps` (`run_id`,`ordinal`,`attempt`);--> statement-breakpoint
CREATE INDEX `run_steps_session_id_idx` ON `run_steps` (`session_id`);--> statement-breakpoint
CREATE INDEX `run_steps_stable_id_idx` ON `run_steps` (`stable_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`correlation_run_id` text,
	`cwd` text NOT NULL,
	`started_at` integer NOT NULL,
	`started_at_iso` text,
	`completed_at` integer NOT NULL,
	`completed_at_iso` text,
	`duration_ms` integer NOT NULL,
	`exit_code` integer NOT NULL,
	`aggregate` text NOT NULL,
	`scope` text,
	`review_brief` text,
	`legacy_suite_run_id` text,
	`cli_version` text,
	`engine_versions` text
);
--> statement-breakpoint
CREATE INDEX `runs_completed_at_idx` ON `runs` ("completed_at" DESC);--> statement-breakpoint
CREATE INDEX `runs_legacy_suite_run_id_idx` ON `runs` (`legacy_suite_run_id`);--> statement-breakpoint
CREATE INDEX `runs_source_completed_at_idx` ON `runs` (`source`,"completed_at" DESC);