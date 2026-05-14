/**
 * @fileoverview `defineInvariantScenario` — invariant-kind entry point.
 *
 * Per Plan 01 Phase 7's "Scenario shape" sketch, an invariant scenario is a
 * `setup → act → assert` lifecycle that exercises an architectural invariant
 * (reconciler scenario, dispatch-bound exclusion, audit chain integrity, etc.)
 *
 * Authors supply:
 *   - identification (id, name, description, tags)
 *   - `relatesToInvariant` — a doc anchor (e.g. `CLAUDE.md#signal-reconciliation/scenario-1`)
 *     verified by Phase 7's meta-test that every invariant scenario points at a
 *     real invariant in CLAUDE.md
 *   - `setup`, `act`, and `assert` callbacks operating on `InvariantContext`
 *
 * The framework owns lifecycle management: phase timing, error capture,
 * abort handling, assertion collection.
 */

import { ValidationError as CoreValidationError } from '@opensip-tools/core'

import { scenarioRegistry } from '../../framework/registry.js'

import { createInvariantScenarioRunner } from './executor.js'

import type { InvariantContext, InvariantContextDeps } from './context.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'


/** Author-facing configuration for an invariant scenario. */
export interface InvariantScenarioConfig {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]
  /** Doc anchor identifying which invariant this scenario verifies. */
  readonly relatesToInvariant: string
  readonly setup: (ctx: InvariantContext) => Promise<void>
  readonly act: (ctx: InvariantContext) => Promise<void>
  readonly assert: (ctx: InvariantContext) => Promise<void>
  /**
   * Optional override for the `InvariantContext` driver dependencies. Tests
   * inject fake drivers here; production scenarios omit this and get the
   * default (throw-NOT-IMPLEMENTED) drivers until Phase 7 wires real ones.
   */
  readonly deps?: Partial<InvariantContextDeps>
}

/** Validation error shape for invariant config. */
export interface InvariantValidationError {
  readonly field: string
  readonly message: string
}

function validateRequired(
  config: InvariantScenarioConfig,
  errors: InvariantValidationError[],
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
  if (!config.relatesToInvariant || config.relatesToInvariant.trim() === '') {
    errors.push({
      field: 'relatesToInvariant',
      message:
        'relatesToInvariant is required (doc anchor, e.g. "CLAUDE.md#signal-reconciliation/scenario-1")',
    })
  }
  if (typeof config.setup !== 'function') {
    errors.push({ field: 'setup', message: 'setup must be an async function' })
  }
  if (typeof config.act !== 'function') {
    errors.push({ field: 'act', message: 'act must be an async function' })
  }
  if (typeof config.assert !== 'function') {
    errors.push({ field: 'assert', message: 'assert must be an async function' })
  }
}

function validateDuplicates(
  config: InvariantScenarioConfig,
  errors: InvariantValidationError[],
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
 * Validate an invariant scenario configuration. Throws on invalid input.
 *
 * @throws {ValidationError} When the invariant scenario configuration is invalid
 */
export function validateInvariantScenarioConfig(config: InvariantScenarioConfig): void {
  const errors: InvariantValidationError[] = []
  validateRequired(config, errors)
  validateDuplicates(config, errors)

  if (errors.length > 0) {
    const messages = errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n')
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError(`Invalid invariant scenario configuration:\n${messages}`, {
      code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
      metadata: { errors, kind: 'invariant' },
    })
  }
}

/**
 * Define an invariant-kind simulation scenario with automatic registration.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineInvariantScenario(config: InvariantScenarioConfig): RunnableScenario {
  validateInvariantScenarioConfig(config)
  const scenario = createInvariantScenarioRunner(config)
  scenarioRegistry.register(scenario)
  return scenario
}

/**
 * Define an invariant scenario without auto-registration (test helper).
 *
 * @throws {ValidationError} When the scenario configuration is invalid (missing id)
 */
export function defineInvariantScenarioWithoutRegistration(
  config: InvariantScenarioConfig,
): RunnableScenario {
  if (!config.id || config.id.trim() === '') {
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError('Invalid invariant scenario configuration: id is required', {
      code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
      metadata: { kind: 'invariant' },
    })
  }
  return createInvariantScenarioRunner(config)
}
