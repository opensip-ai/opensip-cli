/**
 * @fileoverview Chaos-kind executor.
 *
 * Composes the shared `runLoadWindow` driver with explicit failure injection
 * and a recovery window. The current implementation runs the loop for the
 * configured duration with chaos active (`injectChaos` returns failures /
 * `chaos-event` outcomes per the configured probability), then continues
 * for `recoveryWindow` ms with chaos disabled to evaluate recovery
 * assertions.
 *
 * This is the v1 shape — when Plan 01 Phase 9 (chaos scenarios) authors real
 * scenarios, the executor may grow phase-aware metric snapshots and event
 * recording. The result type already accommodates that growth.
 */

import { ScenarioAbortedError } from '../../framework/execution/execution-engine.js'
import { runLoadWindow } from '../../framework/execution/run-load-window.js'
import { ScenarioResultBuilder } from '../../framework/result-builder.js'
import { createScenarioLogger } from '../../framework/scenario-logger.js'

import type { ChaosScenarioConfig } from './define.js'
import type { ChaosAssertionVerdict, ChaosEvent } from './result.js'
import type { TickOutcome } from '../../framework/execution/run-load-window.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type { ChaosScenarioExecutorResult } from '../../framework/scenario-executor-result.js'
import type { SimulationMetrics } from '../../types/base-types.js'
import type {
  ScenarioExecutionContext,
} from '../../types/framework-types.js'

/**
 * Per-tick injection callback for the chaos kind. Returns a `chaos-event`
 * outcome at the configured probability (with the first injection's `type`
 * + `target`); otherwise defers to the default 95% success roll.
 */
function buildInjectChaos(
  config: ChaosScenarioConfig,
): () => TickOutcome {
  return () => {
    if (!config.chaos.enabled || Math.random() >= config.chaos.probability) {
      return null
    }
    const injection = config.chaos.types[0]
    if (!injection) {
      // chaos active but no injection definitions — count as a generic failure.
      return { kind: 'failure' }
    }
    const event: ChaosEvent = {
      type: injection.type,
      atMs: 0, // overwritten below by the loop's timing
      target: injection.target,
    }
    return { kind: 'chaos-event', event }
  }
}

function evaluateAssertionsForWindow(
  scenarioId: string,
  metrics: SimulationMetrics,
  durationSeconds: number,
  assertions: ChaosScenarioConfig['steadyStateAssertions'],
): ChaosAssertionVerdict {
  const built = ScenarioResultBuilder.create(scenarioId)
    .withMetrics(metrics)
    .withDuration(durationSeconds)
    .evaluateAssertions(assertions)
    .build()
  return {
    passed: built.assertions.passed,
    failed: built.assertions.failed,
  }
}

/** Build a `RunnableScenario` for a chaos-kind config. */
export function createChaosScenarioRunner(config: ChaosScenarioConfig): RunnableScenario {
  return Object.freeze({
    kind: 'chaos' as const,
    id: config.id,
    name: config.name,
    description: config.description,
    tags: Object.freeze([...config.tags]),

    run:
      /** @throws {ScenarioAbortedError} When the scenario is aborted via AbortSignal */
      async (abortSignal: AbortSignal): Promise<ChaosScenarioExecutorResult> => {
        const correlationId = `scenario-${config.id}-${Date.now().toString(36)}`
        const context: ScenarioExecutionContext = {
          scenarioId: config.id,
          correlationId,
          abortSignal,
          logger: createScenarioLogger(config.id),
        }
        if (abortSignal.aborted) {
          throw new ScenarioAbortedError(config.id)
        }

        const startTime = Date.now()
        try {
          const steadyDurationMs = config.duration * 1000
          const recoveryDurationMs = config.recoveryWindow

          // Steady-state window: chaos is active.
          const injectChaos = buildInjectChaos(config)
          const steady = await runLoadWindow(config, context, {
            windowMs: steadyDurationMs,
            injectChaos: ({ tickStartMs }) => {
              const outcome = injectChaos()
              if (outcome?.kind === 'chaos-event') {
                // Stamp the relative timestamp the framework supplies.
                return {
                  kind: 'chaos-event',
                  event: { ...outcome.event, atMs: tickStartMs },
                }
              }
              return outcome
            },
          })
          // Recovery window: no injectChaos hook — defaults to 95% success.
          const recovery = await runLoadWindow(config, context, {
            windowMs: recoveryDurationMs,
          })

          const steadyVerdict = evaluateAssertionsForWindow(
            config.id,
            steady.metrics,
            config.duration,
            config.steadyStateAssertions,
          )
          const recoveryVerdict = evaluateAssertionsForWindow(
            config.id,
            recovery.metrics,
            recoveryDurationMs / 1000,
            config.recoveryAssertions,
          )

          const passed =
            steadyVerdict.failed.length === 0 && recoveryVerdict.failed.length === 0

          // The `runLoadWindow` driver returns `LoadWindowEvent[]`; in
          // practice the chaos executor only emits chaos-event outcomes
          // whose payload IS a ChaosEvent. The structural compatibility
          // is documented in run-load-window.ts.
          const chaosEvents: readonly ChaosEvent[] = Object.freeze([
            ...steady.events,
            ...recovery.events,
          ] as ChaosEvent[])

          return Object.freeze({
            kind: 'chaos' as const,
            scenarioId: config.id,
            passed,
            durationMs: Date.now() - startTime,
            signals: Object.freeze([...steady.signals, ...recovery.signals]),
            outcome: Object.freeze({
              steadyStateMetrics: steady.metrics,
              recoveryMetrics: recovery.metrics,
              steadyStateAssertions: steadyVerdict,
              recoveryAssertions: recoveryVerdict,
              chaosEvents,
              recoveryWindowMs: recoveryDurationMs,
            }),
          })
        } catch (error) {
          if (abortSignal.aborted) {
            throw new ScenarioAbortedError(config.id)
          }
          throw error
        }
      },
  })
}
