/**
 * @fileoverview Predicate registry for fix-evaluation scenarios.
 *
 * The fix-evaluation kind references predicates by stable string id (e.g.
 * `tests-pass`). The registry maps each id to an evaluator function. New
 * predicates may be registered at composition time via `registerPredicate`.
 *
 * Per the autoresearch corpus authoring spec, the framework ships with these
 * predicate ids (also enumerated by Phase 0a's audit of the live corpus):
 *
 *   - `tests-pass`              — fixture's `pnpm test` exits 0 after agent edits
 *   - `regex-in-file`           — path + pattern; the file must contain a match
 *   - `no-tests-modified`       — gaming defense (agent must not edit tests)
 *   - `no-files-outside-target` — gaming defense (agent must stay in targets)
 *   - `function-exists`         — symbol the fix is supposed to preserve
 *   - `lint-clean`              — `pnpm lint` exits 0 (spec, not yet in corpus)
 *   - `typecheck-clean`         — `pnpm typecheck` exits 0 (spec, not yet in corpus)
 *   - `file-unchanged`          — path must not be touched (spec, not yet in corpus)
 *
 * The framework-shipped evaluators for primitives that need real harness
 * machinery (running the fixture's tests, scanning the agent's diff, etc.)
 * are typed stubs that throw a clear "not yet implemented in framework"
 * error. Phase 7.5 (autoresearch corpus migration) wires real implementations
 * through the harness.
 */

import { ValidationError as CoreValidationError } from '@opensip-tools/core'

/** Inline arguments for a predicate leaf, indexed by predicate id. */
export type PredicateArgs = Readonly<Record<string, unknown>>

/**
 * Result of evaluating a single predicate leaf.
 */
export interface PredicateEvaluationResult {
  readonly passed: boolean
  /** Optional reason — populated when `passed` is false. */
  readonly reason?: string
}

/** Context the harness threads into each evaluator. */
export interface PredicateEvaluationContext {
  /** Path to the fixture repo the agent operated on. */
  readonly fixturePath: string
  /** Files the agent modified during the run. */
  readonly modifiedFiles: readonly string[]
  /** Files the scenario declared as targets (for `no-files-outside-target`). */
  readonly targetFiles: readonly string[]
  /** Optional metadata the harness exposes (test runner, lint runner, etc.). */
  readonly metadata: Readonly<Record<string, unknown>>
}

/** A predicate evaluator function. */
export type PredicateEvaluator = (
  args: PredicateArgs,
  context: PredicateEvaluationContext,
) => Promise<PredicateEvaluationResult>

// =============================================================================
// REGISTRY
// =============================================================================

const registry = new Map<string, PredicateEvaluator>()

/** Register (or replace) a predicate evaluator. */
export function registerPredicate(id: string, evaluator: PredicateEvaluator): void {
  if (!id || id.trim() === '') {
    // @fitness-ignore-next-line result-pattern-consistency -- programmer error at registration time
    throw new CoreValidationError('registerPredicate requires a non-empty id', {
      code: 'VALIDATION.PREDICATE.EMPTY_ID',
    })
  }
  registry.set(id, evaluator)
}

/** Look up a predicate evaluator by id. Returns `undefined` for unknown ids. */
export function getPredicate(id: string): PredicateEvaluator | undefined {
  return registry.get(id)
}

/** List currently registered predicate ids. */
export function listPredicateIds(): readonly string[] {
  return Object.freeze([...registry.keys()])
}

/** Re-export the registry as a read-only map. Useful for diagnostics. */
export const predicateRegistry: ReadonlyMap<string, PredicateEvaluator> = registry

// =============================================================================
// FRAMEWORK-SHIPPED PREDICATES
// =============================================================================

/**
 * The framework-shipped predicates are typed stubs that throw a clear
 * "not yet implemented" error when invoked. Phase 7.5's harness migration
 * replaces these via `registerPredicate` at composition time.
 */
function makeStubEvaluator(id: string): PredicateEvaluator {
  return async () => {
    // @fitness-ignore-next-line result-pattern-consistency -- intentional stub; harness wires real evaluator
    throw new Error(
      `Predicate '${id}' is registered but not yet implemented in the framework. ` +
        'Phase 7.5 (autoresearch corpus migration) wires the real evaluator through ' +
        'the harness. Use registerPredicate() at composition time to override.',
    )
  }
}

const FRAMEWORK_PREDICATE_IDS = Object.freeze([
  // Active in the live corpus (per Phase 0a discovery)
  'tests-pass',
  'regex-in-file',
  'no-tests-modified',
  'no-files-outside-target',
  'function-exists',
  // Spec-listed but not yet present in the corpus
  'lint-clean',
  'typecheck-clean',
  'file-unchanged',
])

for (const id of FRAMEWORK_PREDICATE_IDS) {
  registerPredicate(id, makeStubEvaluator(id))
}

/** Reset the registry to its framework-shipped baseline. Tests use this. */
export function resetPredicateRegistryToBaseline(): void {
  registry.clear()
  for (const id of FRAMEWORK_PREDICATE_IDS) {
    registerPredicate(id, makeStubEvaluator(id))
  }
}
