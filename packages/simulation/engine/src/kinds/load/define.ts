/**
 * @fileoverview `defineLoadScenario` — load-kind entry point.
 *
 * The load kind preserves the existing personas + ramp + sustain + assert
 * shape that the framework already supported. The author-facing config
 * interface is `LoadScenarioConfig` (no `kind` field — the entry point sets
 * it). Validation runs at definition time; the scenario is registered in the
 * shared cross-kind registry.
 */

import { scenarioRegistry } from '../../framework/registry.js'
import {
  throwValidationErrors,
  validateScenarioMetadata,
  validateScenarioUniqueness,
  type ScenarioValidationError,
} from '../../framework/validation.js'

import { createLoadScenarioRunner } from './executor.js'

import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type {
  CustomExecuteFn,
  PersonaConfig,
  ScenarioAssertion,
} from '../../types/framework-types.js'


/**
 * Author-facing configuration for a load scenario.
 *
 * All optional fields have sensible defaults. The `kind` discriminator is
 * intentionally omitted — `defineLoadScenario` sets it.
 */
export interface LoadScenarioConfig {
  // Required metadata
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]

  // Simulation configuration
  readonly personas: readonly PersonaConfig[]
  readonly duration: number
  readonly rampUp?: number
  readonly targetRps?: number

  // Assertions
  readonly assertions: readonly ScenarioAssertion[]

  // Optional customization
  readonly execute?: CustomExecuteFn
}

/**
 * Validation error with field name and message.
 *
 * @deprecated Use `ScenarioValidationError` from `framework/validation.ts`.
 * Kept as a type alias for one release so external callers keep compiling.
 */
export type LoadValidationError = ScenarioValidationError

function validatePersona(
  persona: PersonaConfig | undefined,
  index: number,
  errors: ScenarioValidationError[],
): void {
  if (!persona) return

  if (!persona.personaId) {
    errors.push({
      field: `personas[${index}].personaId`,
      message: 'personaId is required',
    })
  }
  if (typeof persona.count !== 'number' || persona.count <= 0) {
    errors.push({
      field: `personas[${index}].count`,
      message: 'count must be a positive number',
    })
  }
}

function collectPersonaValidationErrors(
  config: LoadScenarioConfig,
  errors: ScenarioValidationError[],
): void {
  if (config.personas.length === 0) {
    errors.push({ field: 'personas', message: 'at least one persona is required' })
    return
  }

  for (let i = 0; i < config.personas.length; i++) {
    validatePersona(config.personas[i], i, errors)
  }
}

function validateRampUp(config: LoadScenarioConfig, errors: ScenarioValidationError[]): void {
  if (config.rampUp === undefined) return

  if (typeof config.rampUp !== 'number' || config.rampUp < 0) {
    errors.push({ field: 'rampUp', message: 'rampUp must be a non-negative number' })
    return
  }
  if (config.rampUp > config.duration) {
    errors.push({
      field: 'rampUp',
      message: 'rampUp cannot exceed duration',
    })
  }
}

interface ValidateLoadOptions {
  /** Test helper: skip the registry-uniqueness check. */
  readonly skipRegistryCheck?: boolean
}

/**
 * Validate a load scenario configuration. Throws on invalid input.
 *
 * @throws {ValidationError} When the load scenario configuration is invalid
 */
export function validateLoadScenarioConfig(
  config: LoadScenarioConfig,
  options: ValidateLoadOptions = {},
): void {
  const errors: ScenarioValidationError[] = []

  validateScenarioMetadata(config, errors)
  collectPersonaValidationErrors(config, errors)

  if (typeof config.duration !== 'number' || config.duration <= 0) {
    errors.push({ field: 'duration', message: 'duration must be a positive number' })
  }

  validateRampUp(config, errors)

  if (config.assertions.length === 0) {
    errors.push({ field: 'assertions', message: 'at least one assertion is required' })
  }

  validateScenarioUniqueness(config, errors, {
    ...(options.skipRegistryCheck === undefined ? {} : { skipRegistryCheck: options.skipRegistryCheck }),
  })

  throwValidationErrors(errors, 'load')
}

/**
 * Define a load-kind simulation scenario with automatic registration.
 *
 * @example
 * ```typescript
 * export const myScenario = defineLoadScenario({
 *   id: 'my-scenario',
 *   name: 'My Scenario',
 *   description: 'Tests typical user flows',
 *   tags: ['smoke'],
 *   personas: [persona('buyer', 10), persona('seller', 5)],
 *   duration: 300,
 *   assertions: [
 *     ASSERTIONS.lowErrorRate(),
 *     ASSERTIONS.lowLatency('p95', 500),
 *   ],
 * });
 * ```
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineLoadScenario(config: LoadScenarioConfig): RunnableScenario {
  validateLoadScenarioConfig(config)

  const scenario = createLoadScenarioRunner(config)

  scenarioRegistry.register(scenario)

  return scenario
}

/**
 * Define a load scenario without auto-registration (test helper).
 *
 * Same validator as `defineLoadScenario`, just with the registry-uniqueness
 * check disabled so tests can build many scenarios with the same id.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineLoadScenarioWithoutRegistration(
  config: LoadScenarioConfig,
): RunnableScenario {
  validateLoadScenarioConfig(config, { skipRegistryCheck: true })
  return createLoadScenarioRunner(config)
}
