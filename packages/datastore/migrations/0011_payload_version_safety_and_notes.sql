-- Phase 7: Payload schema evolution — outer column safety + notes.
-- The `payload_version` column is created by migration 0010 (NOT NULL DEFAULT 1).
-- This migration intentionally carries NO further DDL: SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, and drizzle's migrator does not emulate it, so
-- re-adding the column here would fail with "duplicate column name". The
-- migration exists to document the two-level versioning model and to run a
-- harmless, idempotent backfill. No JSON rewrite of historical payloads is
-- performed or required (projection on read is the strategy; see plan + ADR-0050).

-- Notes for operators / future migrations:
-- * payload_version (created in 0010) = outer storage contract version (bumped
--   only for host-visible changes between session-store and tools).
-- * The tool-owned inner version lives as "__version" (number) at the top level
--   of the JSON blob in the `payload` column.
-- * Legacy rows (column=1 or absent, or no __version in JSON) are treated as v1
--   with `fidelity: 'projection'`.
-- * Migrations on these tables must remain append-only. Backfills only for safe
--   host columns (timestamp_iso precedent); never rewrite tool JSON.

-- Backfill any rows that somehow missed the DEFAULT (belt-and-suspenders).
UPDATE session_tool_payload SET payload_version = 1 WHERE payload_version IS NULL;
