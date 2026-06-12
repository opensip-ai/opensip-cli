CREATE TABLE `tool_state` (
	`tool` text NOT NULL,
	`key` text NOT NULL,
	`payload` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tool`, `key`)
);
