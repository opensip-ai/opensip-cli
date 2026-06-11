/**
 * @fileoverview Shared in-process `Target`s for simulation tests.
 *
 * These let scenario fixtures drive the real load-window driver without any
 * network I/O. `noopTarget` always succeeds; `countingTarget` records how many
 * times it was invoked (and how many were concurrent) for driver assertions.
 */

import type { Target } from '../../framework/execution/target.js';

/** A target that always succeeds immediately. */
export const noopTarget: Target = () => Promise.resolve();

/** A target that always fails (throws) immediately. */
export const failingTarget: Target = () => Promise.reject(new Error('test-target: forced failure'));

/** A counting target plus its observed call/concurrency stats. */
export interface CountingTarget {
  readonly target: Target;
  /** Total invocations. */
  calls(): number;
  /** Peak simultaneous in-flight invocations observed. */
  maxConcurrent(): number;
}

/**
 * Build a target that resolves after `delayMs` and tracks invocation count +
 * peak concurrency. `delayMs` defaults to 0 (resolve on the next microtask).
 */
export function countingTarget(delayMs = 0): CountingTarget {
  let calls = 0;
  let inFlight = 0;
  let peak = 0;
  return {
    target: async () => {
      calls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } finally {
        inFlight--;
      }
    },
    calls: () => calls,
    maxConcurrent: () => peak,
  };
}
