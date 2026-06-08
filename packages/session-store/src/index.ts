/**
 * @opensip-tools/session-store — tool-run session persistence.
 *
 * Owns the `sessions` / `session_tool_payload` SQLite schema and the
 * `SessionRepo` query layer. Holds ZERO tool vocabulary — the per-session
 * `payload` is opaque to persistence. Extracted from `@opensip-tools/contracts`
 * so that package carries types only (audit 2026-05-29, contracts split).
 *
 * Release 2.12.0 (session replay) adds the inverse of persistence:
 * `decodeSessionPayload` reads a stored payload back into its STRUCTURAL shape
 * (`{ summary, checks[] }`) so each tool can project it to a `SignalEnvelope`.
 * That decoder still holds zero tool vocabulary — severity→category mapping and
 * signal IDs live in each engine's `session-replay.ts`, not here.
 *
 * The raw `sessions` / `sessionToolPayload` Drizzle tables are package-private
 * (ADR-0009): cross-module access goes through `SessionRepo`, never the raw
 * schema. `SessionRepo` consumes them via a relative import; they are not
 * re-exported here and `exports` declares no `./schema` subpath, so no other
 * package can reach them.
 */

export { SessionRepo, type SessionListOptions } from './session-repo.js';
export { resolveSession, type SessionReference, type SessionResolveResult } from './resolve-session.js';
export { generateSessionId, sanitizeForFilename } from './store.js';
export {
  decodeSessionPayload,
  decodeSummary,
  numberField,
  stringField,
  booleanField,
  type DecodedSessionFinding,
  type DecodedSessionCheck,
  type DecodedSessionPayload,
  type DecodeSessionPayloadOptions,
  type SessionPayloadScalar,
} from './session-payload-decode.js';
