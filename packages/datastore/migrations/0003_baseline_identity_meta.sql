ALTER TABLE `tool_baseline_meta` ADD `baseline_format_version` integer;
--> statement-breakpoint
ALTER TABLE `tool_baseline_meta` ADD `fingerprint_strategy_id` text;
--> statement-breakpoint
ALTER TABLE `tool_baseline_meta` ADD `fingerprint_strategy_version` integer;