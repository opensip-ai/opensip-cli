/**
 * @fileoverview `defineFixEvaluationScenario` — fix-evaluation-kind entry point.
 *
 * The fix-evaluation kind runs a fix agent against a synthesized signal and
 * scores the agent's edits against a predicate composition. The shape mirrors
 * the autoresearch corpus YAML schema (`opensip-tools/sim/autoresearch/AUTHORING-SPEC.md`)
 * field-for-field — Phase 7.5's loader emits `defineFixEvaluationScenario(...)`
 * calls and consumes this entry point.
 *
 * Predicate composition references predicates by stable id; unknown ids fail
 * fast at registration time so a typo in the corpus doesn't silently skip a
 * gaming-defense check.
 */

import {
  throwValidationErrors,
  validateScenarioMetadata,
  type ScenarioValidationError,
} from '../../framework/validation.js'


import { createFixEvaluationScenarioRunner } from './executor.js'
import { getPredicate } from './predicates/index.js'

import type {
  FixEvaluationScenarioConfig,
  PredicateComposition,
  PredicateLeaf,
} from './config.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'

// Predicate composition + config types moved to `./config.ts` to break
// the `define.ts ↔ executor.ts` file-level cycle. Re-exported here so
// existing callers keep their import paths.
export type {
  FixEvaluationScenarioConfig,
  PredicateComposition,
  PredicateLeaf,
  SignalPayload,
} from './config.js'

/**
 * Validation error shape for fix-evaluation config.
 *
 * @deprecated Use `ScenarioValidationError` from `framework/validation.ts`.
 */
export type FixEvaluationValidationError = ScenarioValidationError

// =============================================================================
// VALIDATION
// =============================================================================

function validateSignalPayload(
  config: FixEvaluationScenarioConfig,
  errors: ScenarioValidationError[],
): void {
  if (!config.signal) {
    errors.push({ field: 'signal', message: 'signal payload is required' })
  }
}

function validateJudgmentMode(
  config: FixEvaluationScenarioConfig,
  errors: ScenarioValidationError[],
): void {
  if (config.judgmentMode === 'predicate-match') {
    if (!config.predicate) {
      errors.push({
        field: 'predicate',
        message: 'predicate is required when judgmentMode is "predicate-match"',
      })
    }
  } else if (config.predicate) {
    errors.push({
      field: 'predicate',
      message:
        'predicate must be omitted when judgmentMode is not "predicate-match" (got ' +
        `"${config.judgmentMode}")`,
    })
  }
}

/**
 * Walk the predicate tree and ensure every leaf id is registered. Unknown
 * ids fast-fail per AUTHORING-SPEC §5: silent skip would let a typo bypass
 * a gaming-defense check.
 */
function validatePredicateTree(
  node: PredicateComposition | PredicateLeaf | undefined,
  pathTrace: string,
  errors: ScenarioValidationError[],
): void {
  if (!node) return

  // Composite if it has all_of/any_of
  const composition = node as PredicateComposition
  const hasAllOf = Array.isArray(composition.all_of)
  const hasAnyOf = Array.isArray(composition.any_of)
  if (hasAllOf || hasAnyOf) {
    if (hasAllOf && hasAnyOf) {
      errors.push({
        field: pathTrace,
        message: 'predicate node may declare either all_of or any_of, not both',
      })
    }
    const children: readonly (PredicateComposition | PredicateLeaf)[] | undefined =
      hasAllOf ? composition.all_of : composition.any_of
    if (children) {
      children.forEach((child, idx) => {
        const branch = hasAllOf ? 'all_of' : 'any_of'
        validatePredicateTree(child, `${pathTrace}.${branch}[${idx}]`, errors)
      })
    }
    return
  }

  // Leaf — must have id, must resolve in the registry
  const leaf = node as PredicateLeaf
  if (typeof leaf.id !== 'string' || leaf.id.trim() === '') {
    errors.push({ field: pathTrace, message: 'predicate leaf must have a string id' })
    return
  }
  if (!getPredicate(leaf.id)) {
    errors.push({
      field: `${pathTrace}.id`,
      message: `unknown predicate id '${leaf.id}' — register it via registerPredicate() at composition time, or fix the typo`,
    })
  }
}

function validateGamingDefense(
  config: FixEvaluationScenarioConfig,
  errors: ScenarioValidationError[],
): void {
  if (config.judgmentMode !== 'predicate-match' || !config.predicate) {
    return
  }
  const required = new Set(['no-files-outside-target', 'no-tests-modified', 'function-exists'])
  let found = false
  const visit = (node: PredicateComposition | PredicateLeaf): void => {
    const composition = node as PredicateComposition
    const children: readonly (PredicateComposition | PredicateLeaf)[] | undefined =
      composition.all_of ?? composition.any_of
    if (children) {
      for (const child of children) {
        if (found) return
        visit(child)
      }
      return
    }
    const leaf = node as PredicateLeaf
    if (typeof leaf.id === 'string' && required.has(leaf.id)) {
      found = true
    }
  }
  visit(config.predicate)
  if (!found) {
    errors.push({
      field: 'predicate',
      message:
        'predicate-match scenarios must include at least one gaming-defense leaf ' +
        '(no-files-outside-target, no-tests-modified, or function-exists). See ' +
        'AUTHORING-SPEC §2.',
    })
  }
}

/**
 * Validate a fix-evaluation scenario configuration. Throws on invalid input.
 *
 * Uniqueness against an existing scenario registry is checked at
 * registration time, not here.
 *
 * @throws {ValidationError} When the fix-evaluation scenario configuration is invalid
 */
export function validateFixEvaluationScenarioConfig(
  config: FixEvaluationScenarioConfig,
): void {
  const errors: ScenarioValidationError[] = []
  validateScenarioMetadata(config, errors)
  validateSignalPayload(config, errors)
  validateJudgmentMode(config, errors)
  validatePredicateTree(config.predicate, 'predicate', errors)
  validateGamingDefense(config, errors)

  throwValidationErrors(errors, 'fix-evaluation')
}

/**
 * Define a fix-evaluation-kind simulation scenario. Returns the scenario;
 * the caller (typically the simulation plugin loader) is responsible
 * for registering it into `scope.registries.scenarios`.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineFixEvaluationScenario(
  config: FixEvaluationScenarioConfig,
): RunnableScenario {
  validateFixEvaluationScenarioConfig(config)
  return createFixEvaluationScenarioRunner(config)
}
