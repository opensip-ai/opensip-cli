-- Add columns for timestamp fidelity (original ISO) and basic payload versioning.
-- Existing rows: timestamp_iso null (hydrate falls back to reconstructed), payload_version defaults to 1.
-- NOTE: statements are split by drizzle's breakpoint marker so each runs as its
-- own prepared statement (better-sqlite3 rejects multi-statement strings).
ALTER TABLE sessions ADD COLUMN timestamp_iso TEXT;
--> statement-breakpoint
ALTER TABLE session_tool_payload ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Backfill timestamp_iso for old rows (approximate from ms epoch).
-- Note: for exact original, re-persist sessions after upgrade.
UPDATE sessions SET timestamp_iso = strftime('%Y-%m-%dT%H:%M:%fZ', timestamp / 1000, 'unixepoch') WHERE timestamp_iso IS NULL;
