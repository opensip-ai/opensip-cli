-- Additive columns for tool stable UUID (ADR-0048). Legacy rows get NULL;
-- new writes from provenance (when stableId present in manifest) or future
-- ratchet paths can populate it. The `tool` column retains the human name
-- for current queries/compat.
ALTER TABLE `tool_state` ADD COLUMN `stable_id` text;
--> statement-breakpoint
ALTER TABLE `tool_baseline_entries` ADD COLUMN `stable_id` text;
--> statement-breakpoint
ALTER TABLE `tool_baseline_meta` ADD COLUMN `stable_id` text;
