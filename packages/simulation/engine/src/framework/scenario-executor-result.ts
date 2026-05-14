/**
 * @fileoverview Discriminated union over scenario execution results, by `kind`.
 *
 * Per DEC-338, each kind has its own outcome shape. The shared envelope
 * carries `kind`, `scenarioId`, `passed`, `signals`, and `durationMs`; the
 * per-kind `outcome` payload carries the kind-specific evidence.
 *
 * Persistence + dashboard code dispatch on `result.kind` to per-kind
 * renderers. Adding a new kind is a compile-time exhaustiveness break in
 * every dispatch site — that's the architectural ceiling DEC-338 enforces.
 *
 * This commit lands the load variant; subsequent commits extend the union
 * with chaos, invariant, and fix-evaluation variants.
 */


import type { ChaosOutcome } from '../kinds/chaos/result.js'
import type { FixEvaluationOutcome } from '../kinds/fix-evaluation/result.js'
import type { InvariantOutcome } from '../kinds/invariant/result.js'
import type { LoadOutcome } from '../kinds/load/result.js'
import type { Signal } from '@opensip-tools/core'

/** Common envelope fields for every kind's result. */
interface BaseScenarioExecutorResult {
  /** Scenario id this result was produced from (correlates with the registry). */
  readonly scenarioId: string
  /** Top-level pass/fail. Each kind defines its own predicate for `passed`. */
  readonly passed: boolean
  /** Wall-clock duration the scenario ran for, in milliseconds. */
  readonly durationMs: number
  /** Signals emitted during execution (may be empty for kinds that don't emit). */
  readonly signals: readonly Signal[]
}

/** Load-kind result envelope. */
export interface LoadScenarioExecutorResult extends BaseScenarioExecutorResult {
  readonly kind: 'load'
  readonly outcome: LoadOutcome
}

/** Chaos-kind result envelope. */
export interface ChaosScenarioExecutorResult extends BaseScenarioExecutorResult {
  readonly kind: 'chaos'
  readonly outcome: ChaosOutcome
}

/** Invariant-kind result envelope. */
export interface InvariantScenarioExecutorResult extends BaseScenarioExecutorResult {
  readonly kind: 'invariant'
  readonly outcome: InvariantOutcome
}

/** Fix-evaluation-kind result envelope. */
export interface FixEvaluationScenarioExecutorResult extends BaseScenarioExecutorResult {
  readonly kind: 'fix-evaluation'
  readonly outcome: FixEvaluationOutcome
}

/**
 * Discriminated union over scenario executor results.
 *
 * Use exhaustive `switch (result.kind)` to dispatch — TypeScript's narrowing
 * makes per-kind `outcome` access compile-time safe.
 */
export type ScenarioExecutorResult =
  | LoadScenarioExecutorResult
  | ChaosScenarioExecutorResult
  | InvariantScenarioExecutorResult
  | FixEvaluationScenarioExecutorResult
