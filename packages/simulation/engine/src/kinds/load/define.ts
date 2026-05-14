/**
 * @fileoverview `defineLoadScenario` — load-kind entry point.
 *
 * The load kind preserves the existing personas + ramp + sustain + assert
 * shape that the framework already supported. The author-facing config
 * interface is `LoadScenarioConfig` (no `kind` field — the entry point sets
 * it). Validation runs at definition time; the scenario is registered in the
 * shared cross-kind registry.
 */

import { ValidationError as CoreValidationError } from '@opensip-tools/core'

import { scenarioRegistry } from '../../framework/registry.js'

import { createLoadScenarioRunner } from './executor.js'

import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type {
  CustomExecuteFn,
  PersonaConfig,
  ScenarioAssertion,
  ScenarioExecutionOptions,
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

  // Execution options
  readonly options?: ScenarioExecutionOptions
}

/** Validation error with field name and message. */
export interface LoadValidationError {
  readonly field: string
  readonly message: string
}

function validateIdField(config: LoadScenarioConfig, errors: LoadValidationError[]): void {
  if (!config.id || config.id.trim() === '') {
    errors.push({ field: 'id', message: 'id is required' })
    return
  }
  if (!/^[a-z0-9-]+$/.test(config.id)) {
    errors.push({
      field: 'id',
      message: 'id must be lowercase alphanumeric with hyphens',
    })
  }
}

function validatePersona(
  persona: PersonaConfig | undefined,
  index: number,
  errors: LoadValidationError[],
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
  errors: LoadValidationError[],
): void {
  if (config.personas.length === 0) {
    errors.push({ field: 'personas', message: 'at least one persona is required' })
    return
  }

  for (let i = 0; i < config.personas.length; i++) {
    validatePersona(config.personas[i], i, errors)
  }
}

function validateRampUp(config: LoadScenarioConfig, errors: LoadValidationError[]): void {
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

function validateDuplicates(config: LoadScenarioConfig, errors: LoadValidationError[]): void {
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
 * Validate a load scenario configuration. Throws on invalid input.
 *
 * @throws {ValidationError} When the load scenario configuration is invalid
 */
export function validateLoadScenarioConfig(config: LoadScenarioConfig): void {
  const errors: LoadValidationError[] = []

  validateIdField(config, errors)

  if (!config.name || config.name.trim() === '') {
    errors.push({ field: 'name', message: 'name is required' })
  }

  if (config.description.trim() === '') {
    errors.push({ field: 'description', message: 'description is required' })
  }

  collectPersonaValidationErrors(config, errors)

  if (typeof config.duration !== 'number' || config.duration <= 0) {
    errors.push({ field: 'duration', message: 'duration must be a positive number' })
  }

  validateRampUp(config, errors)

  if (config.assertions.length === 0) {
    errors.push({ field: 'assertions', message: 'at least one assertion is required' })
  }

  validateDuplicates(config, errors)

  if (errors.length > 0) {
    const messages = errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n')
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError(`Invalid load scenario configuration:\n${messages}`, {
      code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
      metadata: { errors, kind: 'load' },
    })
  }
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
 * @throws {ValidationError} When the scenario configuration is invalid (missing id)
 */
export function defineLoadScenarioWithoutRegistration(
  config: LoadScenarioConfig,
): RunnableScenario {
  const errors: LoadValidationError[] = []

  if (!config.id || config.id.trim() === '') {
    errors.push({ field: 'id', message: 'id is required' })
  }

  if (errors.length > 0) {
    const messages = errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n')
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError(`Invalid load scenario configuration:\n${messages}`, {
      code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
      metadata: { errors, kind: 'load' },
    })
  }

  return createLoadScenarioRunner(config)
}
