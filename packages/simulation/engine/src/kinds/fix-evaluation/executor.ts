/**
 * @fileoverview Fix-evaluation-kind executor.
 *
 * Phase 0b.5 ships the type-correct runner shape; the actual harness wiring
 * (running an agent against the scenario's signal, capturing the diff,
 * scoring predicates) lands in Phase 7.5 when the autoresearch corpus
 * loader migrates from YAML to `defineFixEvaluationScenario` calls.
 *
 * The runner returns a typed-but-empty result envelope until then; calling
 * `run()` produces a `passed: false` outcome with `predicateMatched: false`
 * and an explicit "harness not wired" reason on every leaf. This keeps the
 * type contract round-trippable while making it explicit that the Phase 7.5
 * implementation is required to get real verdicts.
 */

import { ScenarioAbortedError } from '../../framework/execution/execution-engine.js'

import type {
  FixEvaluationScenarioConfig,
  PredicateComposition,
  PredicateLeaf,
} from './config.js'
import type { PredicateVerdict } from './result.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type { FixEvaluationScenarioExecutorResult } from '../../framework/scenario-executor-result.js'


const HARNESS_NOT_WIRED_REASON =
  'fix-evaluation harness not yet wired (Phase 7.5 — autoresearch corpus migration)'

/** Build a placeholder verdict tree mirroring the input predicate's structure. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- recursive verdict builder: composition vs leaf branches read better as a single function
function placeholderVerdict(
  node: PredicateComposition | PredicateLeaf | undefined,
): PredicateVerdict | undefined {
  if (!node) return undefined
  const composition = node as PredicateComposition
  const hasAllOf = Array.isArray(composition.all_of)
  const hasAnyOf = Array.isArray(composition.any_of)
  if (hasAllOf || hasAnyOf) {
    const combinator: 'all_of' | 'any_of' = hasAllOf ? 'all_of' : 'any_of'
    const childrenSrc: readonly (PredicateComposition | PredicateLeaf)[] | undefined =
      hasAllOf ? composition.all_of : composition.any_of
    const children: PredicateVerdict[] = []
    if (childrenSrc) {
      for (const child of childrenSrc) {
        const verdict = placeholderVerdict(child)
        if (verdict) children.push(verdict)
      }
    }
    return {
      type: 'composite',
      combinator,
      passed: false,
      children: Object.freeze(children),
    }
  }
  const leaf = node as PredicateLeaf
  return {
    type: 'leaf',
    id: typeof leaf.id === 'string' ? leaf.id : 'unknown',
    passed: false,
    reason: HARNESS_NOT_WIRED_REASON,
  }
}

/** Build a `RunnableScenario` for a fix-evaluation-kind config. */
export function createFixEvaluationScenarioRunner(
  config: FixEvaluationScenarioConfig,
): RunnableScenario {
  return Object.freeze({
    kind: 'fix-evaluation' as const,
    id: config.id,
    name: config.name,
    description: config.description,
    tags: Object.freeze([...config.tags]),

    /* eslint-disable-next-line @typescript-eslint/require-await -- run() must match `(signal) => Promise<...>`; placeholder body is currently synchronous */
    run:
      /** @throws {ScenarioAbortedError} When the scenario is aborted via AbortSignal */
      async (abortSignal: AbortSignal): Promise<FixEvaluationScenarioExecutorResult> => {
        if (abortSignal.aborted) {
          throw new ScenarioAbortedError(config.id)
        }

        const startTime = Date.now()
        const verdict = placeholderVerdict(config.predicate)

        return Object.freeze({
          kind: 'fix-evaluation' as const,
          scenarioId: config.id,
          passed: false,
          durationMs: Date.now() - startTime,
          signals: Object.freeze([]),
          outcome: Object.freeze({
            predicateMatched: false,
            verdict,
            agentRun: Object.freeze({
              filesModified: Object.freeze([]),
              testsModified: Object.freeze([]),
              agentReportedSuccess: false,
            }),
            matchedExpectedOutcome: false,
          }),
        })
      },
  })
}
