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


import { createEmptyMetrics } from './result-builder.js'

import type { ScenarioExecutorResult } from './scenario-executor-result.js'
import type { SimulationMetrics } from '../types/base-types.js'

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

/**
 * Project a `ScenarioExecutorResult` into a uniform view shape.
 *
 * @throws {Error} When `result.kind` is not in the known discriminated-union
 *   variants. This is an exhaustiveness guard — a runtime hit means a new
 *   variant was added without updating this dispatch.
 */
export function renderScenarioResultView(
  result: ScenarioExecutorResult,
): ScenarioResultView {
  switch (result.kind) {
    case 'load': {
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
    }

    case 'chaos': {
      const passedCount =
        result.outcome.steadyStateAssertions.passed.length +
        result.outcome.recoveryAssertions.passed.length
      const failedCount =
        result.outcome.steadyStateAssertions.failed.length +
        result.outcome.recoveryAssertions.failed.length
      return {
        kind: 'chaos',
        scenarioId: result.scenarioId,
        passed: result.passed,
        durationMs: result.durationMs,
        metrics: result.outcome.steadyStateMetrics,
        assertionsPassed: passedCount,
        assertionsFailed: failedCount,
        outcomeLabel: `${result.outcome.chaosEvents.length} chaos events, ${failedCount} failed`,
      }
    }

    case 'invariant': {
      const heldCount = result.outcome.assertions.filter((a) => a.held).length
      const failedCount = result.outcome.assertions.length - heldCount
      return {
        kind: 'invariant',
        scenarioId: result.scenarioId,
        passed: result.passed,
        durationMs: result.durationMs,
        metrics: createEmptyMetrics(),
        assertionsPassed: heldCount,
        assertionsFailed: failedCount,
        outcomeLabel: `${result.outcome.assertions.length} invariants checked, ${failedCount} failed`,
      }
    }

    case 'fix-evaluation': {
      // Deferred feature: when the harness isn't wired, label the run as
      // explicitly unavailable rather than as a failed evaluation, so it reads
      // honestly instead of looking like a real (negative) verdict.
      if (!result.outcome.harnessAvailable) {
        return {
          kind: 'fix-evaluation',
          scenarioId: result.scenarioId,
          passed: result.passed,
          durationMs: result.durationMs,
          metrics: createEmptyMetrics(),
          assertionsPassed: 0,
          assertionsFailed: 0,
          outcomeLabel: 'unavailable — fix-evaluation harness deferred',
        }
      }
      return {
        kind: 'fix-evaluation',
        scenarioId: result.scenarioId,
        passed: result.passed,
        durationMs: result.durationMs,
        metrics: createEmptyMetrics(),
        assertionsPassed: result.outcome.predicateMatched ? 1 : 0,
        assertionsFailed: result.outcome.predicateMatched ? 0 : 1,
        outcomeLabel: result.outcome.predicateMatched
          ? 'predicate matched'
          : `predicate did not match (matchedExpectedOutcome=${result.outcome.matchedExpectedOutcome})`,
      }
    }

    default: {
      // Exhaustiveness guard — adding a new variant to the discriminated union
      // turns this assignment into a compile-time error, forcing every dispatch
      // site (including this one) to add the missing branch.
      const _exhaustive: never = result
      // @fitness-ignore-next-line result-pattern-consistency -- exhaustiveness probe; runtime should never hit this
      throw new Error(
        `Unreachable: ScenarioExecutorResult kind exhaustiveness violation (${String(_exhaustive)})`,
      )
    }
  }
}
