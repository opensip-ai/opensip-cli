/**
 * @fileoverview `defineChaosScenario` — chaos-kind entry point.
 *
 * The chaos kind composes a load-style base run with explicit failure injection
 * and a recovery-window assertion contract. Authors supply:
 *   - load-side fields (personas, duration, ramp-up, target RPS)
 *   - a `chaos` injection config (already typed by `ChaosConfig` in base-types)
 *   - `steadyStateAssertions` evaluated while chaos is active
 *   - `recoveryAssertions` evaluated during the post-chaos recovery window
 *   - `recoveryWindow` (ms) — how long after chaos lifts to evaluate recovery
 */

import {
  throwValidationErrors,
  validateScenarioMetadata,
  type ScenarioValidationError,
} from '../../framework/validation.js'

import { createChaosScenarioRunner } from './executor.js'

import type { ChaosScenarioConfig } from './config.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'

// `ChaosScenarioConfig` moved to `./config.ts` to break the
// `define.ts ↔ executor.ts` file-level cycle. Re-exported here so
// callers (the engine barrel, downstream tools) continue to import
// the config shape from `'./define.js'` without churn.
export type { ChaosScenarioConfig } from './config.js'

function validatePersonasAndDuration(
  config: ChaosScenarioConfig,
  errors: ScenarioValidationError[],
): void {
  if (config.personas.length === 0) {
    errors.push({ field: 'personas', message: 'at least one persona is required' })
  }
  if (typeof config.duration !== 'number' || config.duration <= 0) {
    errors.push({ field: 'duration', message: 'duration must be a positive number' })
  }
}

function validateChaos(config: ChaosScenarioConfig, errors: ScenarioValidationError[]): void {
  if (!config.chaos) {
    errors.push({ field: 'chaos', message: 'chaos config is required for chaos scenarios' })
    return
  }
  if (typeof config.chaos.enabled !== 'boolean') {
    errors.push({ field: 'chaos.enabled', message: 'chaos.enabled must be boolean' })
  }
  if (
    typeof config.chaos.probability !== 'number' ||
    config.chaos.probability < 0 ||
    config.chaos.probability > 1
  ) {
    errors.push({
      field: 'chaos.probability',
      message: 'chaos.probability must be in [0, 1]',
    })
  }
  if (!Array.isArray(config.chaos.types)) {
    errors.push({ field: 'chaos.types', message: 'chaos.types must be an array' })
  }
}

function validateAssertions(
  config: ChaosScenarioConfig,
  errors: ScenarioValidationError[],
): void {
  if (config.steadyStateAssertions.length === 0) {
    errors.push({
      field: 'steadyStateAssertions',
      message: 'at least one steady-state assertion is required',
    })
  }
  if (config.recoveryAssertions.length === 0) {
    errors.push({
      field: 'recoveryAssertions',
      message: 'at least one recovery assertion is required',
    })
  }
  if (typeof config.recoveryWindow !== 'number' || config.recoveryWindow < 0) {
    errors.push({
      field: 'recoveryWindow',
      message: 'recoveryWindow must be a non-negative number (milliseconds)',
    })
  }
}

/**
 * Validate a chaos scenario configuration. Throws on invalid input.
 *
 * Uniqueness against an existing scenario registry is checked at
 * registration time, not here.
 *
 * @throws {ValidationError} When the chaos scenario configuration is invalid
 */
export function validateChaosScenarioConfig(config: ChaosScenarioConfig): void {
  const errors: ScenarioValidationError[] = []
  validateScenarioMetadata(config, errors)
  validatePersonasAndDuration(config, errors)
  validateChaos(config, errors)
  validateAssertions(config, errors)

  throwValidationErrors(errors, 'chaos')
}

/**
 * Define a chaos-kind simulation scenario. Returns the scenario; the
 * caller (typically the simulation plugin loader) is responsible for
 * registering it into `scope.registries.scenarios`.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineChaosScenario(config: ChaosScenarioConfig): RunnableScenario {
  validateChaosScenarioConfig(config)
  return createChaosScenarioRunner(config)
}
