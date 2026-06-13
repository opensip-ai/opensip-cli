-- Phase 7: Payload schema evolution — outer column safety + notes.
-- The column was added by 0010 (with DEFAULT 1). This migration is defensive
-- for any DBs that saw a partial 0010, plus documentation of the two-level model.
-- No JSON rewrite of historical payloads is performed or required (projection
-- on read is the strategy; see plan + ADR-0050).

-- Ensure the outer storage version column exists with the documented default.
-- SQLite "ADD COLUMN IF NOT EXISTS" is emulated via the project's migration
-- runner or by the fact that 0010 already ran for most users.
ALTER TABLE session_tool_payload ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 1;

-- Notes for operators / future migrations:
-- * payload_version (this column) = outer storage contract version (bumped only
--   for host-visible changes between session-store and tools).
-- * The tool-owned inner version lives as "__version" (number) at the top level
--   of the JSON blob in the `payload` column.
-- * Legacy rows (column=1 or absent, or no __version in JSON) are treated as v1
--   with `fidelity: 'projection'`.
-- * Migrations on these tables must remain append-only. Backfills only for safe
--   host columns (timestamp_iso precedent); never rewrite tool JSON.

-- Backfill any rows that somehow missed the DEFAULT (belt-and-suspenders).
UPDATE session_tool_payload SET payload_version = 1 WHERE payload_version IS NULL;
