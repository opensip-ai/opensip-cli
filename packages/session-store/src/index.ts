/**
 * @opensip-cli/session-store — tool-run session persistence.
 *
 * Owns the `sessions` / `session_tool_payload` SQLite schema and the
 * `SessionRepo` query layer. Holds ZERO tool vocabulary — the per-session
 * `payload` is opaque to persistence. Extracted from `@opensip-cli/contracts`
 * so that package carries types only (audit 2026-05-29, contracts split).
 *
 * Session replay adds the inverse of persistence:
 * `decodeSessionPayload` reads a stored payload back into its STRUCTURAL shape
 * (`{ summary, checks[] }`) so each tool can project it to a `SignalEnvelope`.
 * The helper that builds replay `Signal` rows is parameterized by tool/category
 * vocabulary; the vocabulary itself still lives in each engine.
 *
 * The raw `sessions` / `sessionToolPayload` Drizzle tables are package-private
 * (ADR-0009): cross-module access goes through `SessionRepo`, never the raw
 * schema. `SessionRepo` consumes them via a relative import; they are not
 * re-exported here and `exports` declares no `./schema` subpath, so no other
 * package can reach them.
 */

export { SessionRepo, type SessionListOptions } from './session-repo.js';
export {
  resolveSession,
  type SessionReference,
  type SessionResolveResult,
} from './resolve-session.js';
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
export {
  buildReplaySignal,
  buildReplaySignals,
  type BuildReplaySignalInput,
  type BuildReplaySignalsInput,
} from './session-replay-signal.js';

// Read-only replay/list projections (ADR-0084) — the pure cores the CLI
// `sessions list` / `sessions show` commands now adapt over, and the read API
// `@opensip-cli/mcp` consumes WITHOUT naming `SessionRepo`.
export { listSessionSummaries, type ListSessionSummariesOptions } from './list-summaries.js';
export {
  resolveAndReplaySession,
  type SessionReplayFn,
  type ResolveAndReplayOptions,
  type ReplaySessionOutcome,
} from './replay-session.js';
export { bundledReplayResolver } from './bundled-replay.js';
