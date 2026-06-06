/**
 * @fileoverview `LoadScenarioConfig` — author-facing configuration.
 *
 * Extracted from `define.ts` into its own leaf module so `executor.ts`
 * can reference the config shape without forming a file-level cycle.
 * See `../chaos/config.ts` for the same pattern.
 */

import type { Target } from '../../framework/execution/target.js';
import type { ScenarioAssertion } from '../../types/framework-types.js';
import type { Workload } from '../../types/workload.js';

/**
 * Author-facing configuration for a load scenario.
 *
 * The `kind` discriminator is intentionally omitted — `defineLoadScenario`
 * sets it. The `target` is the BYO seam the driver calls once per request.
 */
export interface LoadScenarioConfig {
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
  /** Window duration, in seconds. */
  readonly duration: number;

  // Assertions
  readonly assertions: readonly ScenarioAssertion[];
}
