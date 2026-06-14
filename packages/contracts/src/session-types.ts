/**
 * Session persistence contract type.
 *
 * `StoredSession` is the cross-tool shape every tool's session row shares.
 * The runtime (SessionRepo, schema, id/filename helpers) lives in
 * @opensip-cli/session-store; this type stays in contracts as the shared
 * surface tools and the dashboard agree on (audit 2026-05-29, contracts
 * split).
 */

import type { SignalEnvelope } from './signal-envelope.js';
import type { ToolShortId } from '@opensip-cli/core';

/**
 * A persisted tool-run session.
 *
 * Holds only **generic** columns every tool shares — score, pass/fail,
 * timing, provenance. Per-session detail is tool-specific and lives in the
 * opaque {@link StoredSession.payload}: `contracts` holds ZERO tool
 * vocabulary. Each tool owns the shape of its own payload; the dashboard,
 * as the presentation owner, reads the payload and renders it — the same
 * producer/consumer split used for `GraphCatalog`.
 *
 * `timestamp` is the *start* of the user-initiated run (captured early in the
 * command dispatch / live runner before heavy analysis work). `durationMs`
 * is the measured wall time of the analysis itself. Together they let history,
 * `sessions list`, and the report reconstruct "started at T, took D".
 *
 * These two fields are stamped exclusively by the host `RunTimer` via the
 * `ToolCliContext.runSession` seam; tools must not supply their own values.
 */
export interface StoredSession {
  readonly id: string;
  readonly tool: ToolShortId;
  readonly timestamp: string;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly durationMs: number;
  /**
   * Tool-owned opaque per-session detail. `contracts` treats this as
   * `unknown` and never inspects it; the producing tool owns and validates
   * its shape. Absent for tools that persist no detail.
   *
   * ## Inner payload versioning convention
   *
   * All tools (first-party and third-party) MUST stamp new payloads they
   * persist with a top-level numeric `"__version": N` (double-underscore
   * prefix signals infrastructure, not user data). Start at `1` for the
   * current shape.
   *
   * The host (contracts / session-store / datastore) stays ignorant of tool
   * shapes — only the producing tool owns the semantics of its version.
   * The structural decoder tolerates legacy payloads (missing `__version`
   * treated as v1 / legacy with `fidelity: 'projection'`).
   *
   * Example of a versioned tool payload (illustrative v1):
   * ```json
   * {
   *   "__version": 1,
   *   "summary": { "total": 42, "passed": 40, "failed": 2, "errors": 1, "warnings": 1 },
   *   "checks": [ ... ]
   * }
   * ```
   *
   * - Additive / optional fields: safe, no version bump required.
   * - Breaking (remove/rename/ reinterpret required field, change shapes
   *   that replay code depends on): bump `__version` + follow documented
   *   deprecation window (see extending guide and ADR-0050).
   */
  readonly payload?: unknown;
}

/** A tool-owned replay of a stored session projection. */
export interface ToolSessionReplay<R = unknown> {
  /** Human-renderable result for the shared CLI render seam. */
  readonly result: R;
  /** Machine-readable reconstructed envelope emitted by `sessions show --json`. */
  readonly envelope: SignalEnvelope;
  /**
   * Stored sessions currently persist dashboard/detail projections, not the full
   * live run envelope. This marker makes that explicit for machine consumers.
   */
  readonly fidelity: 'projection';
}
