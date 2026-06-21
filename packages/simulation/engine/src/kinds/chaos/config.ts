/**
 * @fileoverview `ChaosScenarioConfig` — author-facing configuration type.
 *
 * Extracted from `define.ts` into its own leaf module so `executor.ts`
 * can reference the config shape without forming a file-level cycle:
 *
 *   `define.ts` → `executor.ts` (uses `createChaosScenarioRunner`)
 *   `executor.ts` → `define.ts`  (uses `ChaosScenarioConfig`)
 *
 * The split inverts the dependency. Both files import the config shape from
 * here, and nothing in this file imports back. `define.ts` re-exports
 * `ChaosScenarioConfig` so callers keep one import path.
 */

import type { FaultSpec } from '../../framework/execution/fault-spec.js';
import type { Target } from '../../framework/execution/target.js';
import type { ScenarioAssertion } from '../../types/framework-types.js';
import type { Workload } from '../../types/workload.js';

/**
 * Author-facing configuration for a chaos scenario.
 *
 * The `kind` discriminator is set by the entry point.
 *
 * Chaos drives a real BYO `target` under client-side fault injection: a
 * steady-state window with the fault model active, then a recovery window with
 * faults lifted. There is intentionally no custom-`execute` escape hatch — the
 * `target` IS the BYO seam.
 */
export interface ChaosScenarioConfig {
  // Required metadata
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];

  // What to drive, and how hard
  /** The BYO target driven once per request (throws on failure). */
  readonly target: Target;
  /** Arrival-rate workload (rps + optional concurrency/ramp). */
  readonly workload: Workload;
  /** Steady-state (fault-active) window duration, in seconds. */
  readonly duration: number;

  // Fault contract
  /** Client-side faults injected during the steady-state window. */
  readonly fault: FaultSpec;
  /** Assertions evaluated on the steady-state (fault-active) metrics. */
  readonly steadyStateAssertions: readonly ScenarioAssertion[];
  /** Assertions evaluated on the recovery (faults-lifted) metrics. */
  readonly recoveryAssertions: readonly ScenarioAssertion[];
  /**
   * Recovery window after faults lift, in **milliseconds** (the `Ms` suffix is
   * explicit so it doesn't read as the seconds-valued `duration` above).
   */
  readonly recoveryWindowMs: number;
}
