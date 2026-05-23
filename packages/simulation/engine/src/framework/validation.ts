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
 * Kind-specific checks (chaos's recovery window, fix-evaluation's
 * predicate tree, invariant's `relatesToInvariant` anchor) stay inline
 * in each define.ts.
 */

import { ValidationError as CoreValidationError } from '@opensip-tools/core'

import { scenarioRegistry } from './registry.js'

import type { ScenarioKind } from '../types/kind-types.js'

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
// REGISTRY UNIQUENESS
// =============================================================================

/**
 * Confirm that no scenario with the same id (or name) is already
 * registered. Test helpers pass `skipRegistryCheck: true` to bypass.
 */
export function validateScenarioUniqueness(
  config: ScenarioMetadataInput,
  errors: ScenarioValidationError[],
  options: { readonly skipRegistryCheck?: boolean } = {},
): void {
  if (options.skipRegistryCheck) return

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
