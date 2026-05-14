/**
 * @fileoverview Deprecated legacy entry point — `defineScenario`.
 *
 * Per Plan 01 Phase 0b.5 / DEC-338, the framework now exposes four kind-specific
 * entry points (`defineLoadScenario`, `defineChaosScenario`,
 * `defineInvariantScenario`, `defineFixEvaluationScenario`). The legacy
 * `defineScenario` accepts the old union-shaped `ScenarioConfig` and routes
 * to `defineLoadScenario` (the only kind it ever actually supported).
 *
 * The alias is shipped for one release to keep existing callers compiling.
 * Authors should migrate to the new entry points; the new code should use
 * `defineLoadScenario` directly.
 *
 * @deprecated Use `defineLoadScenario` from '@opensip-tools/simulation'.
 */

import { logger , ValidationError as CoreValidationError } from '@opensip-tools/core'

import {
  defineLoadScenario,
  defineLoadScenarioWithoutRegistration,
  validateLoadScenarioConfig,
  type LoadValidationError,
 type LoadScenarioConfig } from '../kinds/load/define.js'


import type { RunnableScenario } from './runnable-scenario.js'
import type { ScenarioConfig } from '../types/framework-types.js'



/** Validation error with field name and message (legacy alias). */
export type ValidationError = LoadValidationError

let deprecationWarned = false

function warnOnceLegacyDefineScenario(): void {
  if (deprecationWarned) return
  deprecationWarned = true
  logger.warn({
    evt: 'simulation.scenario.deprecation.define-scenario',
    msg: '`defineScenario` is deprecated; migrate to `defineLoadScenario`. The legacy alias will be removed in a future release.',
  })
}

/**
 * Project the legacy `ScenarioConfig` (with `type` + optional `chaosConfig`) into
 * the new `LoadScenarioConfig` shape. The legacy config's `chaosConfig` is
 * intentionally dropped — chaos behavior moves to `defineChaosScenario`. Authors
 * who relied on `chaosConfig` inside a load scenario should migrate.
 */
function projectLegacyToLoadConfig(config: ScenarioConfig): LoadScenarioConfig {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    tags: config.tags,
    personas: config.personas,
    duration: config.duration,
    ...(config.rampUp === undefined ? {} : { rampUp: config.rampUp }),
    ...(config.targetRps === undefined ? {} : { targetRps: config.targetRps }),
    assertions: config.assertions,
    ...(config.execute ? { execute: config.execute } : {}),
    ...(config.options ? { options: config.options } : {}),
  }
}

/**
 * Validate a (legacy) scenario configuration.
 *
 * @deprecated Use `validateLoadScenarioConfig` from
 * '@opensip-tools/simulation/kinds/load' (or rely on `defineLoadScenario`'s
 * built-in validation).
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function validateScenarioConfig(config: ScenarioConfig): void {
  validateLoadScenarioConfig(projectLegacyToLoadConfig(config))
}

/**
 * Define a (legacy-shaped) simulation scenario.
 *
 * @deprecated Use `defineLoadScenario` instead. This alias projects the legacy
 * `ScenarioConfig` into a `LoadScenarioConfig` and routes to the load kind.
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineScenario(config: ScenarioConfig): RunnableScenario {
  warnOnceLegacyDefineScenario()
  if (config.chaosConfig?.enabled) {
    // Chaos in a load-shaped scenario is the legacy behavior we're leaving behind;
    // surface that to the author rather than silently dropping it.
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError(
      'defineScenario received a chaosConfig with enabled=true. Migrate to `defineChaosScenario` to author chaos scenarios; the legacy alias only supports load scenarios.',
      {
        code: 'VALIDATION.SCENARIO.CHAOS_IN_LEGACY_DEFINE',
        metadata: { id: config.id },
      },
    )
  }
  return defineLoadScenario(projectLegacyToLoadConfig(config))
}

/**
 * Define a (legacy-shaped) scenario without auto-registration.
 *
 * @deprecated Use `defineLoadScenarioWithoutRegistration` instead.
 * @throws {ValidationError} When the scenario configuration is invalid (missing id)
 */
export function defineScenarioWithoutRegistration(config: ScenarioConfig): RunnableScenario {
  warnOnceLegacyDefineScenario()
  return defineLoadScenarioWithoutRegistration(projectLegacyToLoadConfig(config))
}

export {scenarioRegistry, getRegisteredScenarios, getScenario, getScenariosByTag, clearScenarioRegistry} from './registry.js'