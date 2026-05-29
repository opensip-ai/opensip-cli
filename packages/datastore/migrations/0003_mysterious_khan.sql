CREATE TABLE `session_tool_payload` (
	`session_id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
