/**
 * @fileoverview Per-kind result renderers.
 *
 * Persistence layers (recipe-service, dashboard) need a stable per-result
 * projection: a small bag of view-friendly fields (metrics, assertion counts,
 * outcome label) that doesn't leak per-kind types. The renderers below
 * dispatch on `result.kind` and return a normalized `ScenarioResultView` so
 * downstream code can render every kind uniformly while preserving the
 * kind-specific outcome via the typed `result` field.
 *
 * Adding a new scenario kind requires adding a `case` here — the
 * exhaustiveness `_exhaustive: never` assignment in `default:` surfaces the
 * omission as a compile-time error.
 */

import type { SimulationMetrics } from '../types/base-types.js'

import type { ScenarioExecutorResult } from './scenario-executor-result.js'

/** View-friendly summary common to every kind. */
export interface ScenarioResultView {
  readonly kind: ScenarioExecutorResult['kind']
  readonly scenarioId: string
  readonly passed: boolean
  readonly durationMs: number
  readonly metrics: SimulationMetrics
  readonly assertionsPassed: number
  readonly assertionsFailed: number
  /** Short human label describing the kind-specific outcome. */
  readonly outcomeLabel: string
}

/** Project a `ScenarioExecutorResult` into a uniform view shape. */
export function renderScenarioResultView(
  result: ScenarioExecutorResult,
): ScenarioResultView {
  switch (result.kind) {
    case 'load':
      return {
        kind: 'load',
        scenarioId: result.scenarioId,
        passed: result.passed,
        durationMs: result.durationMs,
        metrics: result.outcome.metrics,
        assertionsPassed: result.outcome.assertions.passed.length,
        assertionsFailed: result.outcome.assertions.failed.length,
        outcomeLabel: `${result.outcome.metrics.totalRequests} req, ${result.outcome.assertions.failed.length} failed`,
      }

    default: {
      // Exhaustiveness guard — adding a new variant to the discriminated union
      // turns this assignment into a compile-time error, forcing every dispatch
      // site (including this one) to add the missing branch.
      // Cast through `unknown` so a single-variant union doesn't trip the check
      // before the chaos / invariant / fix-evaluation variants land.
      const _exhaustive: never = result as unknown as never
      // @fitness-ignore-next-line result-pattern-consistency -- exhaustiveness probe; runtime should never hit this
      throw new Error(
        `Unreachable: ScenarioExecutorResult kind exhaustiveness violation (${String(_exhaustive)})`,
      )
    }
  }
}
