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
 * lifecycle timing, host metrics, provenance. Per-session detail is
 * tool-specific and lives in the opaque {@link StoredSession.payload}:
 * `contracts` holds ZERO tool vocabulary. Each tool owns the shape of its own
 * payload; the dashboard, as the presentation owner, reads the payload and
 * renders it — the same producer/consumer split used for `GraphCatalog`.
 *
 * ## Host-owned run lifecycle timing (host-owned-run-timing)
 *
 * - `startedAt` is the wall-clock start of the user-initiated tool run,
 *   captured by the host run-lifecycle plane *after* the per-run `RunScope`
 *   exists and *before* any tool-owned setup / handler / live-renderer work.
 * - `completedAt` is the wall-clock instant the tool handler / live renderer
 *   returned its completion data to the host, *before* host persistence,
 *   render, egress, or report side effects.
 * - `durationMs` is the canonical tool-invocation duration (monotonic
 *   elapsed between the two boundaries), **not** TTY-busy time.
 *
 * All three are stamped exclusively by the host run-lifecycle plane from a
 * single `RunLifecycle`. Tools never capture `new Date()` / `Date.now()` /
 * `performance.now()` for these fields and never supply them — they return a
 * `ToolSessionContribution` (verdict/score/recipe/payload) and the host owns
 * the timing. See the clock taxonomy in the spec / session docs.
 *
 * `hostMetrics` (when present) explains *host-side* overhead — TTY occupancy,
 * render, persist, egress, total command time — separately from the canonical
 * `durationMs`. It is a hydrated projection of the sibling host-metrics record
 * keyed by session id, not necessarily a column on the `sessions` table.
 */
export interface StoredSession {
  readonly id: string;
  readonly tool: ToolShortId;
  /** Wall-clock start of the tool run (host run-lifecycle plane). */
  readonly startedAt: string;
  /** Wall-clock completion of the tool run (when the tool returned to the host). */
  readonly completedAt: string;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  /** Canonical tool-invocation duration (monotonic), not TTY-busy time. */
  readonly durationMs: number;
  /**
   * Host-side overhead metrics for this run, hydrated from the sibling
   * host-metrics record. Absent when no metrics were captured. These are NOT
   * a replacement for `durationMs` — they answer "where did host-side cost
   * accumulate", not "how long did the tool take".
   */
  readonly hostMetrics?: StoredSessionHostMetrics;
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

/**
 * Host-side overhead metrics for a single tool run, captured on separate
 * clocks from the canonical `durationMs` (host-owned-run-timing §5.3/§5.4).
 *
 * Stored in a sibling host-metrics record keyed by session id (so render /
 * egress metrics — known only *after* the initial session write — can be
 * upserted without rewriting the session row) and hydrated back onto
 * {@link StoredSession.hostMetrics} for readers. Every field is optional: a
 * given run only populates the metrics observable for its path (e.g.
 * `ttyBusyMs` only for live/TTY runs).
 */
export interface StoredSessionHostMetrics {
  /** Time the interactive TTY was occupied by the live view. */
  readonly ttyBusyMs?: number;
  /** Time spent rendering the final static/live completion output. */
  readonly renderMs?: number;
  /** Time spent writing the session row + payload. */
  readonly persistMs?: number;
  /** Time spent in host-owned post-run signal/report delivery. */
  readonly egressMs?: number;
  /** Elapsed time for the full command action, including host pre/post work. */
  readonly totalCommandMs?: number;
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
