/**
 * @fileoverview Load-kind result outcome.
 *
 * The load kind's outcome is the SLO-style metrics + assertion verdict that
 * scenarios produce. Field-for-field parity with the `LoadResultPayload`
 * metrics/assertions shape that `ScenarioResultBuilder` emits, so assertions
 * carry through unchanged.
 */

import type { SimulationMetrics } from '../../types/base-types.js';
import type { ScenarioAssertion, FailedAssertion } from '../../types/framework-types.js';

/** Outcome payload for a load-kind scenario. */
export interface LoadOutcome {
  /** Final aggregated metrics from the simulation loop. */
  readonly metrics: SimulationMetrics;
  /** Assertions split into passed and failed buckets. */
  readonly assertions: {
    readonly passed: readonly ScenarioAssertion[];
    readonly failed: readonly FailedAssertion[];
  };
}
