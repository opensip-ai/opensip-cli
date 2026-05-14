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

import { ValidationError as CoreValidationError } from '@opensip-tools/core'

import { scenarioRegistry } from '../../framework/registry.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type { ChaosConfig } from '../../types/base-types.js'
import type {
  CustomExecuteFn,
  PersonaConfig,
  ScenarioAssertion,
  ScenarioExecutionOptions,
} from '../../types/framework-types.js'

import { createChaosScenarioRunner } from './executor.js'

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

/** Validation error shape for chaos config. */
export interface ChaosValidationError {
  readonly field: string
  readonly message: string
}

function validateRequired(
  config: ChaosScenarioConfig,
  errors: ChaosValidationError[],
): void {
  if (!config.id || !/^[a-z0-9-]+$/.test(config.id)) {
    errors.push({ field: 'id', message: 'id must be lowercase alphanumeric with hyphens' })
  }
  if (!config.name || config.name.trim() === '') {
    errors.push({ field: 'name', message: 'name is required' })
  }
  if (!config.description || config.description.trim() === '') {
    errors.push({ field: 'description', message: 'description is required' })
  }
  if (config.personas.length === 0) {
    errors.push({ field: 'personas', message: 'at least one persona is required' })
  }
  if (typeof config.duration !== 'number' || config.duration <= 0) {
    errors.push({ field: 'duration', message: 'duration must be a positive number' })
  }
}

function validateChaos(config: ChaosScenarioConfig, errors: ChaosValidationError[]): void {
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
  errors: ChaosValidationError[],
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

function validateDuplicates(
  config: ChaosScenarioConfig,
  errors: ChaosValidationError[],
): void {
  if (config.id && scenarioRegistry.has(config.id)) {
    errors.push({
      field: 'id',
      message: `scenario with id '${config.id}' is already registered`,
    })
  }
  if (config.name && scenarioRegistry.has(config.name)) {
    errors.push({
      field: 'name',
      message: `scenario with name '${config.name}' is already registered`,
    })
  }
}

/**
 * Validate a chaos scenario configuration. Throws on invalid input.
 *
 * @throws {ValidationError} When the chaos scenario configuration is invalid
 */
export function validateChaosScenarioConfig(config: ChaosScenarioConfig): void {
  const errors: ChaosValidationError[] = []
  validateRequired(config, errors)
  validateChaos(config, errors)
  validateAssertions(config, errors)
  validateDuplicates(config, errors)

  if (errors.length > 0) {
    const messages = errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n')
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError(`Invalid chaos scenario configuration:\n${messages}`, {
      code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
      metadata: { errors, kind: 'chaos' },
    })
  }
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
 * @throws {ValidationError} When the scenario configuration is invalid (missing id)
 */
export function defineChaosScenarioWithoutRegistration(
  config: ChaosScenarioConfig,
): RunnableScenario {
  if (!config.id || config.id.trim() === '') {
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError('Invalid chaos scenario configuration: id is required', {
      code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
      metadata: { kind: 'chaos' },
    })
  }
  return createChaosScenarioRunner(config)
}
