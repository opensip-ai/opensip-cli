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

import { ValidationError as CoreValidationError } from '@opensip-tools/core'
import type { CreateSignalInput } from '@opensip-tools/core'

import { scenarioRegistry } from '../../framework/registry.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'

import { createFixEvaluationScenarioRunner } from './executor.js'
import { getPredicate } from './predicates/index.js'

// =============================================================================
// PREDICATE COMPOSITION TYPES
// =============================================================================

/** A leaf node in the predicate composition tree. */
export interface PredicateLeaf {
  readonly id: string
  /** Inline arguments for the predicate (e.g. path/pattern for regex-in-file). */
  readonly [arg: string]: unknown
}

/** Composition combinator for predicate trees. */
export interface PredicateComposition {
  readonly all_of?: readonly (PredicateComposition | PredicateLeaf)[]
  readonly any_of?: readonly (PredicateComposition | PredicateLeaf)[]
}

// =============================================================================
// SIGNAL PAYLOAD
// =============================================================================

/**
 * Signal payload the scenario emits. Aligned with `CreateSignalInput` from
 * `@opensip-tools/core` — the harness populates `id`/`fingerprint`/`createdAt`
 * at run time.
 */
export type SignalPayload = CreateSignalInput

// =============================================================================
// AUTHOR-FACING CONFIG
// =============================================================================

/** Author-facing configuration for a fix-evaluation scenario. */
export interface FixEvaluationScenarioConfig {
  // Identification
  readonly id: string
  readonly name: string
  readonly description: string
  readonly tags: readonly string[]

  // Coverage-matrix annotations (per AUTHORING-SPEC §1)
  readonly category:
    | 'error'
    | 'warning'
    | 'performance'
    | 'security'
    | 'architecture'
    | 'quality'
  readonly score: 0 | 1 | 2 | 3 | 4 | 5
  readonly criteriaMet: readonly string[]
  readonly source:
    | 'fitness'
    | 'simulation'
    | 'assess'
    | 'continuous-review'
    | 'import'
    | 'sarif'
    | 'otlp'
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  readonly expectedDifficulty: 'trivial' | 'medium' | 'hard'
  readonly signalIntent: 'actionable' | 'advisory'
  readonly judgmentMode: 'predicate-match' | 'pipeline-judged' | 'human-review'
  readonly provenance: 'real-world-inspired' | 'manual-matrix' | 'llm-authored'
  readonly expectedOutcome: 'success' | 'failure' | 'escalation'

  // Signal payload + predicate composition
  readonly signal: SignalPayload
  readonly predicate?: PredicateComposition

  // Optional list of files the scenario targets (used by no-files-outside-target)
  readonly targets?: readonly string[]
}

/** Validation error shape for fix-evaluation config. */
export interface FixEvaluationValidationError {
  readonly field: string
  readonly message: string
}

// =============================================================================
// VALIDATION
// =============================================================================

function validateRequired(
  config: FixEvaluationScenarioConfig,
  errors: FixEvaluationValidationError[],
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
  if (!config.signal) {
    errors.push({ field: 'signal', message: 'signal payload is required' })
  }
}

function validateJudgmentMode(
  config: FixEvaluationScenarioConfig,
  errors: FixEvaluationValidationError[],
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
  errors: FixEvaluationValidationError[],
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
    const children = hasAllOf ? composition.all_of : composition.any_of
    if (Array.isArray(children)) {
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
  errors: FixEvaluationValidationError[],
): void {
  if (config.judgmentMode !== 'predicate-match' || !config.predicate) {
    return
  }
  const required = new Set(['no-files-outside-target', 'no-tests-modified', 'function-exists'])
  let found = false
  const visit = (node: PredicateComposition | PredicateLeaf): void => {
    const composition = node as PredicateComposition
    const children = Array.isArray(composition.all_of)
      ? composition.all_of
      : Array.isArray(composition.any_of)
        ? composition.any_of
        : null
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

function validateDuplicates(
  config: FixEvaluationScenarioConfig,
  errors: FixEvaluationValidationError[],
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
 * Validate a fix-evaluation scenario configuration. Throws on invalid input.
 *
 * @throws {ValidationError} When the fix-evaluation scenario configuration is invalid
 */
export function validateFixEvaluationScenarioConfig(
  config: FixEvaluationScenarioConfig,
): void {
  const errors: FixEvaluationValidationError[] = []
  validateRequired(config, errors)
  validateJudgmentMode(config, errors)
  validatePredicateTree(config.predicate, 'predicate', errors)
  validateGamingDefense(config, errors)
  validateDuplicates(config, errors)

  if (errors.length > 0) {
    const messages = errors.map((e) => `  - ${e.field}: ${e.message}`).join('\n')
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError(
      `Invalid fix-evaluation scenario configuration:\n${messages}`,
      {
        code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
        metadata: { errors, kind: 'fix-evaluation' },
      },
    )
  }
}

/**
 * Define a fix-evaluation-kind simulation scenario with automatic registration.
 *
 * @throws {ValidationError} When the scenario configuration is invalid
 */
export function defineFixEvaluationScenario(
  config: FixEvaluationScenarioConfig,
): RunnableScenario {
  validateFixEvaluationScenarioConfig(config)
  const scenario = createFixEvaluationScenarioRunner(config)
  scenarioRegistry.register(scenario)
  return scenario
}

/**
 * Define a fix-evaluation scenario without auto-registration (test helper).
 *
 * @throws {ValidationError} When the scenario configuration is invalid (missing id)
 */
export function defineFixEvaluationScenarioWithoutRegistration(
  config: FixEvaluationScenarioConfig,
): RunnableScenario {
  if (!config.id || config.id.trim() === '') {
    // @fitness-ignore-next-line result-pattern-consistency -- definition-time validation, throw is appropriate
    throw new CoreValidationError(
      'Invalid fix-evaluation scenario configuration: id is required',
      {
        code: 'VALIDATION.SCENARIO.INVALID_CONFIG',
        metadata: { kind: 'fix-evaluation' },
      },
    )
  }
  return createFixEvaluationScenarioRunner(config)
}
