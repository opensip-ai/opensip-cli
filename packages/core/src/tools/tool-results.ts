/**
 * @fileoverview Host seam result shapes returned to tools.
 *
 * The baseline/ratchet compare result and the post-run signal-delivery
 * result returned by the matching {@link ToolCliContext} seams. Split out of
 * the kitchen-sink `types.ts` contract hub (M6); re-exported from there so the
 * public surface is unchanged.
 */

import type { Signal } from '../types/signal.js';

/**
 * Result of the host baseline/ratchet compare seam (ADR-0036) — three full-object
 * buckets + the gate decision. Core declares this thin shape for the
 * {@link ToolCliContext.compareBaseline} return so `core` need not import
 * `@opensip-cli/output` (which owns the authoritative `GateCompareResult` used
 * by `diffBaseline`). The two are kept structurally in sync by a dedicated test
 * (`core ↔ output GateCompareResult must not diverge`).
 */
export interface GateCompareResult {
  /** Findings present now but not in the baseline (current ∖ baseline). */
  readonly added: readonly Signal[];
  /** Findings present in the baseline but not now (baseline ∖ current). */
  readonly resolved: readonly Signal[];
  /** Findings present in both (current ∩ baseline). */
  readonly unchanged: readonly Signal[];
  /** True iff `added` is non-empty — the gate decision. */
  readonly degraded: boolean;
}

/**
 * Outcome of the root's post-run signal delivery
 * ({@link ToolCliContext.deliverSignals}). Delivery stays best-effort and
 * non-blocking (ADR-0008) — this result exists so a caller (or a test) can
 * SURFACE what happened instead of the user silently assuming their signals
 * shipped. The root already prints the user-facing skip/failure notices; tools
 * may ignore the result entirely.
 */
export interface SignalDeliveryResult {
  /** Signals the cloud sink acknowledged (0 for the keyless/no-op majority). */
  readonly cloudAccepted: number;
  /**
   * Why an ACTIVE cloud sink accepted nothing, when knowable: `'unentitled'`
   * (the entitlement check said no) or `'error'` (the emit faulted). Omitted on
   * success and for the no-op sink (user opted out / no key — silence correct).
   */
  readonly cloudSkippedReason?: 'unentitled' | 'error';
  /** Whether a `--report-to` upload was attempted and succeeded. */
  readonly reportSuccess?: boolean;
  /** The `--report-to` target URL, when one was requested. */
  readonly reportUrl?: string;
}
