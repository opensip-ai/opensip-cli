/**
 * @opensip-tools/session-store — tool-run session persistence.
 *
 * Owns the `sessions` / `session_tool_payload` SQLite schema and the
 * `SessionRepo` query layer. Holds ZERO tool vocabulary — the per-session
 * `payload` is opaque. Extracted from `@opensip-tools/contracts` so that
 * package carries types only (audit 2026-05-29, contracts split).
 */

export { SessionRepo, type SessionListOptions } from './session-repo.js';
export { sessions, sessionToolPayload } from './schema/sessions.js';
export { generateSessionId, sanitizeForFilename } from './store.js';
