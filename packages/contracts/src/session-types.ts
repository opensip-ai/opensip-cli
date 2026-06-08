/**
 * Session persistence contract type.
 *
 * `StoredSession` is the cross-tool shape every tool's session row shares.
 * The runtime (SessionRepo, schema, id/filename helpers) lives in
 * @opensip-tools/session-store; this type stays in contracts as the shared
 * surface tools and the dashboard agree on (audit 2026-05-29, contracts
 * split).
 */

import type { SignalEnvelope } from './signal-envelope.js';
import type { ToolShortId } from '@opensip-tools/core';

/**
 * A persisted tool-run session.
 *
 * Holds only **generic** columns every tool shares — score, pass/fail,
 * timing, provenance. Per-session detail is tool-specific and lives in the
 * opaque {@link StoredSession.payload}: `contracts` holds ZERO tool
 * vocabulary. Each tool owns the shape of its own payload; the dashboard,
 * as the presentation owner, reads the payload and renders it — the same
 * producer/consumer split used for `GraphCatalog`.
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
