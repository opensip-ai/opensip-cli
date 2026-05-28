/**
 * @fileoverview `ChaosScenarioConfig` — author-facing configuration type.
 *
 * Extracted from `define.ts` into its own leaf module so `executor.ts`
 * can reference the config shape without forming a file-level cycle:
 *
 *   `define.ts` → `executor.ts` (uses `createChaosScenarioRunner`)
 *   `executor.ts` → `define.ts`  (uses `ChaosScenarioConfig`)
 *
 * The split inverts the dependency. Both files now import the config
 * shape from here, and nothing in this file imports back. `define.ts`
 * re-exports `ChaosScenarioConfig` so existing callers (the engine's
 * public barrel, downstream tools) see no API change.
 */

import type { ChaosConfig } from '../../types/base-types.js';
import type {
  PersonaConfig,
  ScenarioAssertion,
} from '../../types/framework-types.js';

/**
 * Author-facing configuration for a chaos scenario.
 *
 * The `kind` discriminator is set by the entry point.
 *
 * Chaos is a framework-driven kind — the runner always uses the shared
 * `runLoadWindow` driver with explicit injection plus a recovery window.
 * A custom-`execute` escape hatch would undermine the injection model and
 * is intentionally omitted here.
 */
export interface ChaosScenarioConfig {
  // Required metadata
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];

  // Base load configuration
  readonly personas: readonly PersonaConfig[];
  readonly duration: number;
  readonly rampUp?: number;
  readonly targetRps?: number;

  // Chaos contract
  readonly chaos: ChaosConfig;
  readonly steadyStateAssertions: readonly ScenarioAssertion[];
  readonly recoveryAssertions: readonly ScenarioAssertion[];
  /** Recovery window in milliseconds after chaos lifts. */
  readonly recoveryWindow: number;
}
