/**
 * @fileoverview Fix-evaluation-kind result outcome.
 *
 * The fix-evaluation kind runs a fix agent against a signal, then scores the
 * result against a predicate composition. The outcome captures:
 *   - the predicate composition's overall verdict
 *   - per-leaf verdicts (so reviewers can see which predicate failed)
 *   - the agent run summary (artifacts, edits, diff scope)
 */

/** Verdict for a single predicate leaf evaluation. */
export interface PredicateLeafVerdict {
  /** The predicate id (e.g. 'tests-pass'). */
  readonly id: string
  /** Whether this leaf evaluated to true. */
  readonly passed: boolean
  /** Optional explanation (regex non-match, file outside target, etc.). */
  readonly reason?: string
}

/** Verdict for a composite predicate node (all_of / any_of). */
export interface PredicateCompositeVerdict {
  readonly combinator: 'all_of' | 'any_of'
  readonly passed: boolean
  readonly children: readonly PredicateVerdict[]
}

/** Discriminated union of leaf and composite predicate verdicts. */
export type PredicateVerdict =
  | (PredicateLeafVerdict & { readonly type: 'leaf' })
  | (PredicateCompositeVerdict & { readonly type: 'composite' })

/** Summary of the agent's edits during the run. */
export interface AgentRunSummary {
  /** Files the agent modified. */
  readonly filesModified: readonly string[]
  /** Tests the agent modified (subset of filesModified, for gaming-defense). */
  readonly testsModified: readonly string[]
  /** Whether the fix agent declared success. */
  readonly agentReportedSuccess: boolean
}

/** Outcome payload for a fix-evaluation-kind scenario. */
export interface FixEvaluationOutcome {
  /** Whether the predicate composition evaluated to true. */
  readonly predicateMatched: boolean
  /** Verdict tree for the composition (mirrors the input predicate structure). */
  readonly verdict: PredicateVerdict | undefined
  /** Summary of the agent's run (edits, tests touched, declared success). */
  readonly agentRun: AgentRunSummary
  /** Whether the actual outcome matches the scenario's `expectedOutcome`. */
  readonly matchedExpectedOutcome: boolean
}
