CREATE TABLE `policy_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text,
	`timestamp` text NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject` text,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`reasons` text,
	`source_tiers` text,
	`matched_exception_ids` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `policy_audit_events_timestamp_idx` ON `policy_audit_events` (`timestamp`);
