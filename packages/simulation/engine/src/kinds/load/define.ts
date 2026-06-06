/**
 * @fileoverview `defineLoadScenario` — load-kind entry point.
 *
 * The load kind drives a BYO `target` at a `workload` (rps + optional
 * concurrency/ramp) over `duration` seconds and asserts measured SLOs. The
 * author-facing config interface is `LoadScenarioConfig` (no `kind` field — the
 * entry point sets it). Validation runs at definition time; registration is the
 * caller's responsibility (the simulation plugin loader walks `module.scenarios`
 * and registers them into `scope.registries.scenarios`).
 */

import {
  throwValidationErrors,
  validateScenarioMetadata,
  validateTargetAndWorkload,
  type ScenarioValidationError,
} from '../../framework/validation.js'

import { createLoadScenarioRunner } from './executor.js'

import type { LoadScenarioConfig } from './config.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'

// `LoadScenarioConfig` moved to `./config.ts` to break the
// `define.ts ↔ executor.ts` file-level cycle. Re-exported here so
// existing callers keep their import paths.
export type { LoadScenarioConfig } from './config.js'

function validateRampUp(config: LoadScenarioConfig, errors: ScenarioValidationError[]): void {
  const { rampUp } = config.workload ?? {}
  if (rampUp === undefined) return

  if (typeof rampUp !== 'number' || rampUp < 0) {
    errors.push({ field: 'workload.rampUp', message: 'workload.rampUp must be a non-negative number' })
    return
  }
  if (rampUp > config.duration) {
    errors.push({ field: 'workload.rampUp', message: 'workload.rampUp cannot exceed duration' })
  }
}

/**
 * Validate a load scenario configuration. Throws on invalid input.
 *
 * Uniqueness against an existing scenario registry is checked at
 * registration time (`scope.registries.scenarios.register(...)`), not
 * here — `defineX` returns a scenario object without touching any
 * registry.
 *
 * @throws {ValidationError} When the load scenario configuration is invalid
 */
export function validateLoadScenarioConfig(config: LoadScenarioConfig): void {
  const errors: ScenarioValidationError[] = []

  validateScenarioMetadata(config, errors)
  validateTargetAndWorkload(config, errors)

  if (typeof config.duration !== 'number' || config.duration <= 0) {
    errors.push({ field: 'duration', message: 'duration must be a positive number' })
  }

  validateRampUp(config, errors)

  if (config.assertions.length === 0) {
    errors.push({ field: 'assertions', message: 'at least one assertion is required' })
  }

  throwValidationErrors(errors, 'load')
}

/**
 * Define a load-kind simulation scenario.
 *
 * @example
 * ```typescript
 * export const myScenario = defineLoadScenario({
 *   id: 'my-scenario',
 *   name: 'My Scenario',
 *   description: 'Drives the checkout endpoint',
 *   tags: ['smoke'],
 *   target: httpTarget({ url: process.env.TARGET_URL! }),
 *   workload: { rps: 50, rampUp: 5 },
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

  return createLoadScenarioRunner(config)
}
