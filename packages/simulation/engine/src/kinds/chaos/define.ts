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

import { scenarioRegistry } from '../../framework/registry.js'
import {
  throwValidationErrors,
  validateScenarioMetadata,
  validateScenarioUniqueness,
  type ScenarioValidationError,
} from '../../framework/validation.js'

import { createChaosScenarioRunner } from './executor.js'

import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type { ChaosConfig } from '../../types/base-types.js'
import type {
  CustomExecuteFn,
  PersonaConfig,
  ScenarioAssertion,
  ScenarioExecutionOptions,
} from '../../types/framework-types.js'


/**
 * Author-facing configuration for a chaos scenario.
 *
 * The `kind` discriminator is set by the entry point.
 */
export interface ChaosScenarioConfig {
  // Required metadata
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]

  // Base load configuration
  readonly personas: readonly PersonaConfig[]
  readonly duration: number
  readonly rampUp?: number
  readonly targetRps?: number

  // Chaos contract
  readonly chaos: ChaosConfig
  readonly steadyStateAssertions: readonly ScenarioAssertion[]
  readonly recoveryAssertions: readonly ScenarioAssertion[]
  /** Recovery window in milliseconds after chaos lifts. */
  readonly recoveryWindow: number

  // Optional customization
  readonly execute?: CustomExecuteFn

  // Execution options
  readonly options?: ScenarioExecutionOptions
}

/**
 * Validation error shape for chaos config.
 *
 * @deprecated Use `ScenarioValidationError` from `framework/validation.ts`.
 */
export type ChaosValidationError = ScenarioValidationError

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

interface ValidateChaosOptions {
  /** Test helper: skip the registry-uniqueness check. */
  readonly skipRegistryCheck?: boolean
}

/**
 * Validate a chaos scenario configuration. Throws on invalid input.
 *
 * @throws {ValidationError} When the chaos scenario configuration is invalid
 */
export function validateChaosScenarioConfig(
  config: ChaosScenarioConfig,
  options: ValidateChaosOptions = {},
): void {
  const errors: ScenarioValidationError[] = []
  validateScenarioMetadata(config, errors)
  validatePersonasAndDuration(config, errors)
  validateChaos(config, errors)
  validateAssertions(config, errors)
  validateScenarioUniqueness(config, errors, {
    ...(options.skipRegistryCheck === undefined ? {} : { skipRegistryCheck: options.skipRegistryCheck }),
  })

  throwValidationErrors(errors, 'chaos')
}

/**
 * Define a chaos-kind simulation scenario with automatic registration.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineChaosScenario(config: ChaosScenarioConfig): RunnableScenario {
  validateChaosScenarioConfig(config)
  const scenario = createChaosScenarioRunner(config)
  scenarioRegistry.register(scenario)
  return scenario
}

/**
 * Define a chaos scenario without auto-registration (test helper).
 *
 * Same validator as `defineChaosScenario`, with the registry-uniqueness
 * check disabled.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineChaosScenarioWithoutRegistration(
  config: ChaosScenarioConfig,
): RunnableScenario {
  validateChaosScenarioConfig(config, { skipRegistryCheck: true })
  return createChaosScenarioRunner(config)
}
