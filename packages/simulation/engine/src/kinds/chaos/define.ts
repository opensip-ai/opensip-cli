/**
 * @fileoverview `defineChaosScenario` — chaos-kind entry point.
 *
 * The chaos kind drives a real BYO `target` under client-side fault injection
 * with a recovery-window assertion contract. Authors supply:
 *   - a `target` (the BYO seam) + a `workload` (rps/concurrency/ramp) + `duration`
 *   - a `fault` spec (client-side faults + probability)
 *   - `steadyStateAssertions` evaluated while faults are active
 *   - `recoveryAssertions` evaluated during the post-fault recovery window
 *   - `recoveryWindow` (ms) — how long after faults lift to evaluate recovery
 */

import {
  throwValidationErrors,
  validateScenarioMetadata,
  validateTargetAndWorkload,
  type ScenarioValidationError,
} from '../../framework/validation.js';

import { createChaosScenarioRunner } from './executor.js';

import type { ChaosScenarioConfig } from './config.js';
import type { RunnableScenario } from '../../framework/runnable-scenario.js';

// `ChaosScenarioConfig` moved to `./config.ts` to break the
// `define.ts ↔ executor.ts` file-level cycle. Re-exported here so
// callers (the engine barrel, downstream tools) continue to import
// the config shape from `'./define.js'` without churn.
export type { ChaosScenarioConfig } from './config.js';

const VALID_FAULT_KINDS = new Set(['latency', 'abort', 'drop']);

/**
 * Chaos-specific workload-timing checks: `rampUp` must be non-negative and
 * `duration` must be positive. The common `target`/`workload.rps`/
 * `workload.concurrency` checks live in the shared
 * `validateTargetAndWorkload`; these stay inline because chaos uses a
 * different `rampUp` message ("must be non-negative") than load and does not
 * cross-check `rampUp` against `duration`.
 */
function validateChaosWorkloadTiming(
  config: ChaosScenarioConfig,
  errors: ScenarioValidationError[],
): void {
  if (config.workload?.rampUp !== undefined && config.workload.rampUp < 0) {
    errors.push({ field: 'workload.rampUp', message: 'workload.rampUp must be non-negative' });
  }
  if (typeof config.duration !== 'number' || config.duration <= 0) {
    errors.push({ field: 'duration', message: 'duration must be a positive number' });
  }
}

function validateFault(config: ChaosScenarioConfig, errors: ScenarioValidationError[]): void {
  if (!config.fault) {
    errors.push({ field: 'fault', message: 'fault spec is required for chaos scenarios' });
    return;
  }
  if (
    typeof config.fault.probability !== 'number' ||
    config.fault.probability < 0 ||
    config.fault.probability > 1
  ) {
    errors.push({
      field: 'fault.probability',
      message: 'fault.probability must be in [0, 1]',
    });
  }
  if (config.fault.faults.length === 0) {
    errors.push({ field: 'fault.faults', message: 'fault.faults must be a non-empty array' });
    return;
  }
  for (const [i, f] of config.fault.faults.entries()) {
    if (!VALID_FAULT_KINDS.has(f.kind)) {
      errors.push({
        field: `fault.faults[${i}].kind`,
        message: "fault kind must be one of 'latency' | 'abort' | 'drop'",
      });
    }
    if (f.kind === 'latency' && (typeof f.ms !== 'number' || f.ms < 0)) {
      errors.push({
        field: `fault.faults[${i}].ms`,
        message: 'latency fault requires a non-negative ms',
      });
    }
  }
}

function validateAssertions(config: ChaosScenarioConfig, errors: ScenarioValidationError[]): void {
  if (config.steadyStateAssertions.length === 0) {
    errors.push({
      field: 'steadyStateAssertions',
      message: 'at least one steady-state assertion is required',
    });
  }
  if (config.recoveryAssertions.length === 0) {
    errors.push({
      field: 'recoveryAssertions',
      message: 'at least one recovery assertion is required',
    });
  }
  if (typeof config.recoveryWindow !== 'number' || config.recoveryWindow < 0) {
    errors.push({
      field: 'recoveryWindow',
      message: 'recoveryWindow must be a non-negative number (milliseconds)',
    });
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
  const errors: ScenarioValidationError[] = [];
  validateScenarioMetadata(config, errors);
  validateTargetAndWorkload(config, errors);
  validateChaosWorkloadTiming(config, errors);
  validateFault(config, errors);
  validateAssertions(config, errors);

  throwValidationErrors(errors, 'chaos');
}

/**
 * Define a chaos-kind simulation scenario. Returns the scenario; the
 * caller (typically the simulation plugin loader) is responsible for
 * registering it into `scope.registries.scenarios`.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineChaosScenario(config: ChaosScenarioConfig): RunnableScenario {
  validateChaosScenarioConfig(config);
  return createChaosScenarioRunner(config);
}
