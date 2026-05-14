/**
 * @fileoverview Shared runtime contract for scenarios across all kinds.
 *
 * Every kind's `defineXxxScenario` entry point produces a `RunnableScenario`
 * carrying its `kind` discriminator. Consumers (registry, recipe service,
 * persistence, dashboard) dispatch on `kind` to handle per-kind result variants.
 */

import type { ScenarioExecutorResult } from './scenario-executor-result.js'
import type { ScenarioKind } from '../types/kind-types.js'


/**
 * A validated, runnable scenario.
 *
 * The `kind` field is the architectural discriminator: persistence and
 * dashboard code branch on it to handle each kind's `outcome` payload variant
 * inside `ScenarioExecutorResult`.
 */
export interface RunnableScenario {
  readonly kind: ScenarioKind
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]

  /**
   * Run the scenario with the given abort signal.
   * The returned result's `kind` field MUST match this scenario's `kind`.
   */
  run(abortSignal: AbortSignal): Promise<ScenarioExecutorResult>
}

/** Registry-compatible entry. */
export interface ScenarioRegistryEntry {
  readonly id: string
  readonly name: string
  readonly kind: ScenarioKind
  readonly scenario: RunnableScenario
  readonly tags: readonly string[]
}
