// @fitness-ignore-file batch-operation-limits -- the for-of loops iterate the run's bounded finding set (a Map keyed by fingerprint); pure synchronous Map iteration, no async/IO per item.
/**
 * @fileoverview Pure baseline diff — the generic net-new ratchet (ADR-0036).
 *
 * One symmetric three-bucket diff (`added` / `resolved` / `unchanged`) over full
 * `Signal` objects, replacing fitness's `GateViolation` buckets and graph's
 * asymmetric `newSignals` + bare-string `resolvedFingerprints`. Keyed on the
 * signal's **already-stamped** `fingerprint` (the tool stamps at
 * envelope-construction time via `stampFingerprints`); the diff — and the plane —
 * NEVER re-fingerprints. Pure: no IO, `core`-only import (layer-legal in
 * `output`).
 */

import type { Signal } from '@opensip-cli/core';

/** One loaded baseline row: an opaque fingerprint + its stored full payload. */
export interface BaselineDiffRow {
  readonly fingerprint: string;
  readonly payload: Signal | null;
}

/** Result of comparing current findings to a saved baseline (ADR-0036). */
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
 * Reconstruct a `resolved`-bucket Signal from a baseline row whose payload is
 * absent (defensive — legacy/null rows; new rows always carry payload). Carries
 * the fingerprint so consumers can still identify the resolved finding.
 */
function syntheticSignal(fingerprint: string): Signal {
  return {
    id: `sig_resolved`,
    source: 'baseline',
    provider: 'opensip-cli',
    severity: 'low',
    category: 'quality',
    ruleId: 'unknown',
    message: '(resolved finding; baseline payload unavailable)',
    filePath: '',
    metadata: {},
    fingerprint,
    createdAt: new Date(0).toISOString(),
  };
}

/**
 * Diff current findings against a loaded baseline. Current signals are keyed by
 * their already-stamped `fingerprint`; the diff asserts each is present (the
 * plane never fingerprints) and throws if a tool handed unstamped signals.
 *
 * @throws {Error} when a current signal has no `fingerprint`.
 */
export function diffBaseline(
  current: readonly Signal[],
  baseline: readonly BaselineDiffRow[],
): GateCompareResult {
  const currentByFp = new Map<string, Signal>();
  for (const signal of current) {
    if (!signal.fingerprint) {
      throw new Error(
        `diffBaseline: signal ${signal.ruleId} has no fingerprint — the tool must stamp signals ` +
          `(stampFingerprints) at envelope-construction time before the gate seam; the plane never fingerprints.`,
      );
    }
    currentByFp.set(signal.fingerprint, signal);
  }

  const baselineByFp = new Map<string, BaselineDiffRow>();
  for (const row of baseline) baselineByFp.set(row.fingerprint, row);

  const added: Signal[] = [];
  const unchanged: Signal[] = [];
  for (const [fp, signal] of currentByFp) {
    if (baselineByFp.has(fp)) {
      unchanged.push(signal);
    } else {
      added.push(signal);
    }
  }

  const resolved: Signal[] = [];
  for (const [fp, row] of baselineByFp) {
    if (!currentByFp.has(fp)) {
      resolved.push(row.payload ?? syntheticSignal(fp));
    }
  }

  return { added, resolved, unchanged, degraded: added.length > 0 };
}
