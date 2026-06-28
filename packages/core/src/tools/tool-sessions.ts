/**
 * @fileoverview Tool generic-session contract leaves (host-owned-run-timing).
 *
 * The canonical stored-session leaf, the replay contribution, the
 * tool-returned session contribution + run completion, and the host-recorded
 * run-session shapes for the host-owned run-lifecycle plane. Split out of the
 * kitchen-sink `types.ts` contract hub (M6); re-exported from there so the
 * public surface is unchanged.
 */

import type { ToolShortId } from './ids.js';
import type { ToolRunOutcome } from './run-outcome.js';
import type { RunTimer } from '../lib/run-timer.js';

/**
 * Canonical generic stored-session leaf shape accepted by tool replay hooks.
 *
 * Core owns the contract leaf because replay hooks live on the core `Tool`
 * interface and core cannot import contracts. `@opensip-cli/contracts`
 * extends this shape for the persisted `StoredSession` facade by adding
 * host-side metrics.
 */
export interface ToolSessionRecord {
  readonly id: string;
  readonly tool: ToolShortId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly cwd: string;
  readonly suiteRunId?: string;
  readonly suiteName?: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  /**
   * Persisted run health (ADR-0060, Phase 6). Absent on legacy rows — readers
   * infer `passed`/`failed` from `passed` and never infer `degraded`/`error`.
   */
  readonly runOutcome?: ToolRunOutcome;
  readonly durationMs: number;
  readonly payload?: unknown;
}

/** Optional tool contribution for host-owned `sessions show` replay. */
export interface ToolSessionReplayContribution {
  readonly tool: ToolShortId;
  readonly replaySession: (stored: ToolSessionRecord) => unknown;
}

/**
 * The generic-session contribution a tool returns from its command handler or
 * live renderer (host-owned-run-timing §6.2).
 *
 * Tools provide only verdict + payload + provenance. The host run-lifecycle
 * plane stamps `startedAt` / `completedAt` / `durationMs` (from the shared
 * `RunLifecycle`), generates the stable `id`, and performs the actual
 * `SessionRepo.save` *after* the tool returns. Tools never capture run timing
 * and never call a generic-session writer themselves.
 *
 * Persistence is best-effort: when no datastore is available (non-project
 * commands, or tests without a scope) the host writes nothing observable.
 * Tools must never assume a row was written.
 */
export interface ToolSessionContribution {
  readonly tool: ToolShortId;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  /** Host-stamped when persisting; tools may supply for strict degraded runs. */
  readonly runOutcome?: ToolRunOutcome;
  /** Tool-owned opaque payload (same contract as StoredSession.payload). */
  readonly payload?: unknown;
}

/**
 * What a tool command handler or live renderer returns to the host so the
 * host can complete the run lifecycle and persist the generic session row
 * (host-owned-run-timing §6.2).
 *
 * - `result` / `envelope` are the tool's domain outputs (the same shapes the
 *   handler already produced) — optional so a live renderer that only persists
 *   can return just `session`.
 * - `session` is the generic-session contribution the host persists.
 *
 * The host receives this and owns the rest; the tool supplies no lifecycle
 * timing and performs no generic-session write.
 */
export interface ToolRunCompletion {
  readonly result?: unknown;
  readonly envelope?: unknown;
  readonly session?: ToolSessionContribution;
}

/**
 * The host-recorded session, returned by the host run plane after it persists a
 * {@link ToolSessionContribution}. Carries the id the host assigned and the
 * timing it stamped from the run lifecycle. This is a HOST-internal return shape
 * (the run plane → host), not a tool-facing seam.
 */
export interface RecordedToolRunSession {
  readonly id: string;
  readonly tool: ToolShortId;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
}

/**
 * The host-provided run seam on `ToolCliContext` (host-owned-run-timing §6.5).
 *
 * `timing` is the host run lifecycle for this invocation — READ-ONLY lifecycle
 * inspection for display (e.g. live elapsed in a summary). The launch surface
 * intentionally exposes NO generic-session writer: tools return a
 * {@link ToolSessionContribution} (inside a {@link ToolRunCompletion}) from
 * their handler / live renderer and the host persists it after they resolve.
 */
export interface ToolRunSessions {
  readonly timing: RunTimer;
}
