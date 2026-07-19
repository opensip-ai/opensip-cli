/**
 * Bounded mutable accounting for one ephemeral-runtime prune pass.
 */

import type { PruneEphemeralResult } from './ephemeral-runtime.js';

/** Per-pass mutation and classification counters. */
export interface PruneExecution {
  attempts: number;
  deletions: number;
  budgetExhausted: boolean;
  removedOrphaned: number;
  removedStale: number;
  removedOverflow: number;
  readonly removedKeys: Set<string>;
  readonly attemptedKeys: Set<string>;
  readonly skippedActive: Set<string>;
  readonly skippedChanged: Set<string>;
}

/** Create zeroed, bounded accounting for one prune pass. */
export function createPruneExecution(): PruneExecution {
  return {
    attempts: 0,
    deletions: 0,
    budgetExhausted: false,
    removedOrphaned: 0,
    removedStale: 0,
    removedOverflow: 0,
    removedKeys: new Set(),
    attemptedKeys: new Set(),
    skippedActive: new Set(),
    skippedChanged: new Set(),
  };
}

/** Return the conservative no-deletion result used when proof is incomplete. */
export function emptyPruneResult(): PruneEphemeralResult {
  return {
    scanned: 0,
    removedOrphaned: 0,
    removedStale: 0,
    removedOverflow: 0,
    skippedActive: 0,
    skippedChanged: 0,
  };
}
