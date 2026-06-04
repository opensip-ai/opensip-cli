/**
 * @opensip-tools/session-store — tool-run session persistence.
 *
 * Owns the `sessions` / `session_tool_payload` SQLite schema and the
 * `SessionRepo` query layer. Holds ZERO tool vocabulary — the per-session
 * `payload` is opaque. Extracted from `@opensip-tools/contracts` so that
 * package carries types only (audit 2026-05-29, contracts split).
 *
 * The raw `sessions` / `sessionToolPayload` Drizzle tables are package-private
 * (ADR-0009): cross-module access goes through `SessionRepo`, never the raw
 * schema. `SessionRepo` consumes them via a relative import; they are not
 * re-exported here and `exports` declares no `./schema` subpath, so no other
 * package can reach them.
 */

export { SessionRepo, type SessionListOptions } from './session-repo.js';
export { generateSessionId, sanitizeForFilename } from './store.js';
