CREATE TABLE `graph_shard_fragment` (
	`shard_id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`cache_key` text NOT NULL,
	`shard_fingerprint` text NOT NULL,
	`payload` text NOT NULL
);
