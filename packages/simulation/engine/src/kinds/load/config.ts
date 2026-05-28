/**
 * @fileoverview `LoadScenarioConfig` — author-facing configuration.
 *
 * Extracted from `define.ts` into its own leaf module so `executor.ts`
 * can reference the config shape without forming a file-level cycle.
 * See `../chaos/config.ts` for the same pattern.
 */

import type {
  CustomExecuteFn,
  PersonaConfig,
  ScenarioAssertion,
} from '../../types/framework-types.js';

/**
 * Author-facing configuration for a load scenario.
 *
 * All optional fields have sensible defaults. The `kind` discriminator is
 * intentionally omitted — `defineLoadScenario` sets it.
 */
export interface LoadScenarioConfig {
  // Required metadata
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];

  // Simulation configuration
  readonly personas: readonly PersonaConfig[];
  readonly duration: number;
  readonly rampUp?: number;
  readonly targetRps?: number;

  // Assertions
  readonly assertions: readonly ScenarioAssertion[];

  // Optional customization
  readonly execute?: CustomExecuteFn;
}
