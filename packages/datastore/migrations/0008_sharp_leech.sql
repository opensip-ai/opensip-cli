DROP INDEX `run_steps_session_id_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `run_steps_session_id_unique_idx` ON `run_steps` (`session_id`);--> statement-breakpoint
CREATE INDEX `sessions_timestamp_idx` ON `sessions` ("timestamp" DESC);