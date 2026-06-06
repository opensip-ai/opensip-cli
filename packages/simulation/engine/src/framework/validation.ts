/**
 * @fileoverview Shared validation helpers for `defineXxxScenario` entry
 * points.
 *
 * Each kind's `defineXxxScenarioConfig` validator used to repeat the same
 * three blocks: identifier-shape checks, registry-uniqueness checks, and
 * the `errors -> ValidationError` collector. Centralising them here gives
 * uniform semantics (every kind enforces id/name shape the same way and
 * stamps the same `code: 'VALIDATION.SCENARIO.INVALID_CONFIG'`).
 *
 * Kind-specific checks (e.g. chaos's recovery window) stay inline in
 * each define.ts.
 */

import { ValidationError as CoreValidationError } from '@opensip-tools/core'

import type { ScenarioKind } from '../types/kind-types.js'
import type { Target } from './execution/target.js'
import type { Workload } from '../types/workload.js'

// =============================================================================
// PUBLIC TYPES
// =============================================================================

/** A single validation error: which field failed and why. */
export interface ScenarioValidationError {
  readonly field: string
  readonly message: string
}

/**
 * Subset of fields every scenario kind shares — id / name / description.
 * The validators below operate on this shape so each kind can pass its
 * concrete config in.
 */
export interface ScenarioMetadataInput {
  readonly id?: string
  readonly name?: string
  readonly description?: string
}

/**
 * The common `target` + `workload` subset every driven scenario kind
 * shares (load, chaos). Both `LoadScenarioConfig` and `ChaosScenarioConfig`
 * are assignable to this — the shared validator operates on this shape so
 * each kind can pass its concrete config in.
 */
export interface TargetWorkloadInput {
  readonly target: Target
  readonly workload: Workload
}

/** Options for shared metadata validation. */
export interface ValidateMetadataOptions {
  /**
   * If true (default), `id` is checked against `^[a-z0-9-]+$`. Some kinds
   * (load) historically reported the empty-id case separately; setting
   * `requireId: 'shape'` keeps the strict form check, while
   * `requireId: 'present-only'` only checks for non-empty.
   */
  readonly requireId?: 'shape' | 'present-only'
  /** When true (default), `name` must be a non-empty trimmed string. */
  readonly requireName?: boolean
  /** When true (default), `description` must be a non-empty trimmed string. */
  readonly requireDescription?: boolean
}

// =============================================================================
// METADATA VALIDATION
// =============================================================================

/**
 * Validate the shared metadata block (id / name / description) on any
 * scenario config. Mutates `errors` in place — no return value, matching
 * each kind's existing helper-collector style.
 */
export function validateScenarioMetadata(
  config: ScenarioMetadataInput,
  errors: ScenarioValidationError[],
  options: ValidateMetadataOptions = {},
): void {
  const requireId = options.requireId ?? 'shape'
  const requireName = options.requireName ?? true
  const requireDescription = options.requireDescription ?? true

  // id
  const id = config.id
  if (!id || id.trim() === '') {
    errors.push({ field: 'id', message: 'id is required' })
  } else if (requireId === 'shape' && !/^[a-z0-9-]+$/.test(id)) {
    errors.push({
      field: 'id',
      message: 'id must be lowercase alphanumeric with hyphens',
    })
  }

  // name
  if (requireName && (!config.name || config.name.trim() === '')) {
    errors.push({ field: 'name', message: 'name is required' })
  }

  // description
  if (requireDescription && (!config.description || config.description.trim() === '')) {
    errors.push({ field: 'description', message: 'description is required' })
  }
}

// =============================================================================
// TARGET + WORKLOAD VALIDATION
// =============================================================================

/**
 * Validate the shared `target` + `workload` block common to every driven
 * scenario kind (load, chaos):
 *   - `target` must be a function (the BYO seam),
 *   - `workload.rps` must be a positive number,
 *   - `workload.concurrency`, when defined, must be >= 1.
 *
 * Mutates `errors` in place — no return value, matching the helper-collector
 * style of `validateScenarioMetadata`. Kind-specific workload checks
 * (e.g. load's `rampUp` vs `duration`, chaos's inline `rampUp`/`duration`)
 * stay inline in each define.ts.
 */
export function validateTargetAndWorkload(
  config: TargetWorkloadInput,
  errors: ScenarioValidationError[],
): void {
  if (typeof config.target !== 'function') {
    errors.push({ field: 'target', message: 'target must be a function (the BYO seam)' })
  }
  if (typeof config.workload?.rps !== 'number' || config.workload.rps <= 0) {
    errors.push({ field: 'workload.rps', message: 'workload.rps must be a positive number' })
  }
  if (config.workload?.concurrency !== undefined && config.workload.concurrency < 1) {
    errors.push({ field: 'workload.concurrency', message: 'workload.concurrency must be >= 1' })
  }
}

// =============================================================================
// THROW COLLECTED ERRORS
// =============================================================================

/**
 * Format a `ScenarioValidationError[]` and throw a `CoreValidationError`
 * with the canonical `'VALIDATION.SCENARIO.INVALID_CONFIG'` code if any
 * errors were collected. No-op when the list is empty.
 *
 * @throws {CoreValidationError} When `errors` is non-empty.
 */
export function throwValidationErrors(
  errors: readonly ScenarioValidationError[],
  kind: ScenarioKind,
): void {
  if (errors.length === 0) return
  const messages = errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n')
  // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
  throw new CoreValidationError(`Invalid ${kind} scenario configuration:\n${messages}`, {
    code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
    metadata: { errors: [...errors], kind },
  })
}
