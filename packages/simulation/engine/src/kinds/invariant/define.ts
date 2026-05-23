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

import { scenarioRegistry } from '../../framework/registry.js'
import {
  throwValidationErrors,
  validateScenarioMetadata,
  validateScenarioUniqueness,
  type ScenarioValidationError,
} from '../../framework/validation.js'

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

/**
 * Validation error shape for invariant config.
 *
 * @deprecated Use `ScenarioValidationError` from `framework/validation.ts`.
 */
export type InvariantValidationError = ScenarioValidationError

function validateInvariantSpecific(
  config: InvariantScenarioConfig,
  errors: ScenarioValidationError[],
): void {
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

interface ValidateInvariantOptions {
  /** Test helper: skip the registry-uniqueness check. */
  readonly skipRegistryCheck?: boolean
}

/**
 * Validate an invariant scenario configuration. Throws on invalid input.
 *
 * @throws {ValidationError} When the invariant scenario configuration is invalid
 */
export function validateInvariantScenarioConfig(
  config: InvariantScenarioConfig,
  options: ValidateInvariantOptions = {},
): void {
  const errors: ScenarioValidationError[] = []
  validateScenarioMetadata(config, errors)
  validateInvariantSpecific(config, errors)
  validateScenarioUniqueness(config, errors, {
    ...(options.skipRegistryCheck === undefined ? {} : { skipRegistryCheck: options.skipRegistryCheck }),
  })

  throwValidationErrors(errors, 'invariant')
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
 * Same validator as `defineInvariantScenario`, with the registry-uniqueness
 * check disabled.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineInvariantScenarioWithoutRegistration(
  config: InvariantScenarioConfig,
): RunnableScenario {
  validateInvariantScenarioConfig(config, { skipRegistryCheck: true })
  return createInvariantScenarioRunner(config)
}
