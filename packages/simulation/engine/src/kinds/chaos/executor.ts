/**
 * @fileoverview Chaos-kind executor.
 *
 * Composes the load executor with explicit failure injection + a recovery
 * window. The current implementation runs the load engine for the configured
 * duration with chaos active, then continues for `recoveryWindow` ms with
 * chaos disabled to evaluate recovery assertions.
 *
 * This is the v1 shape — when Plan 01 Phase 9 (chaos scenarios) authors real
 * scenarios, the executor may grow phase-aware metric snapshots and event
 * recording. The result type already accommodates that growth.
 */

import { logger } from '@opensip-tools/core'


import { ScenarioAbortedError } from '../../framework/execution/execution-engine.js'
import { LatencyTracker } from '../../framework/execution/latency-tracker.js'
import { getEstimatedRps } from '../../framework/personas.js'
import { ScenarioResultBuilder, createEmptyMetrics } from '../../framework/result-builder.js'

import type { ChaosScenarioConfig } from './define.js'
import type { ChaosAssertionVerdict, ChaosEvent } from './result.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type { ChaosScenarioExecutorResult } from '../../framework/scenario-executor-result.js'
import type { SimulationMetrics } from '../../types/base-types.js'
import type {
  ScenarioExecutionContext,
  ScenarioLogger,
} from '../../types/framework-types.js'
import type { Signal } from '@opensip-tools/core'

function createScenarioLogger(scenarioId: string): ScenarioLogger {
  return {
    info: (message, data) => {
      logger.info({ evt: 'simulation.scenario.info', scenarioId, msg: message, ...data })
    },
    warn: (message, data) => {
      logger.warn({ evt: 'simulation.scenario.warn', scenarioId, msg: message, ...data })
    },
    error: (message, data) => {
      logger.error({
        evt: 'simulation.scenario.error',
        err: data?.err instanceof Error ? data.err : undefined,
        scenarioId,
        msg: message,
        ...data,
      })
    },
    debug: (message, data) => {
      logger.debug({ evt: 'simulation.scenario.debug', scenarioId, msg: message, ...data })
    },
  }
}

/**
 * Run a single load-style window producing aggregate metrics + signals.
 * Used twice by the chaos executor — once during the chaos-active window,
 * once during the recovery window.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- chaos load window driver: tracks request lifecycle (spawn/await/abort) and aggregates metrics inline
async function runWindow(
  config: ChaosScenarioConfig,
  context: ScenarioExecutionContext,
  windowMs: number,
  chaosActive: boolean,
): Promise<{ metrics: SimulationMetrics; signals: Signal[]; events: ChaosEvent[] }> {
  const targetRps = config.targetRps ?? getEstimatedRps(config.personas)
  const metrics = createEmptyMetrics()
  const latencyTracker = new LatencyTracker()
  const events: ChaosEvent[] = []
  const signals: Signal[] = []
  const tickIntervalMs = 100
  const start = Date.now()
  const rampUpMs = (config.rampUp ?? 0) * 1000

  while (Date.now() - start < windowMs) {
    if (context.abortSignal.aborted) break
    const elapsed = Date.now() - start
    const rampUpProgress = rampUpMs > 0 ? Math.min(1, elapsed / rampUpMs) : 1
    const currentRps = targetRps * rampUpProgress
    const requestsThisTick = Math.floor(currentRps / (1000 / tickIntervalMs))

    for (let i = 0; i < requestsThisTick; i++) {
      if (context.abortSignal.aborted) break
      const latency = Math.random() * 50 + 1
      metrics.totalRequests++
      latencyTracker.record(latency)

      // While chaos is active, fire injection events at the configured probability
      // and inflate the failure rate.
      if (chaosActive && config.chaos.enabled && Math.random() < config.chaos.probability) {
        metrics.failedRequests++
        metrics.errorsGenerated++
        const injection = config.chaos.types[0]
        if (injection) {
          events.push({
            type: injection.type,
            atMs: Date.now() - start,
            target: injection.target,
          })
        }
      } else if (Math.random() < 0.95) {
        metrics.successfulRequests++
      } else {
        metrics.failedRequests++
        metrics.errorsGenerated++
      }
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, tickIntervalMs)
      if (context.abortSignal.aborted) {
        clearTimeout(timeout)
        resolve()
      }
    })
  }

  const snapshot = latencyTracker.getLatencySnapshot()
  metrics.avgLatencyMs = snapshot.avgLatencyMs
  metrics.p50LatencyMs = snapshot.p50LatencyMs
  metrics.p95LatencyMs = snapshot.p95LatencyMs
  metrics.p99LatencyMs = snapshot.p99LatencyMs
  metrics.findingsGenerated = signals.length

  return { metrics, signals, events }
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

          const steady = await runWindow(config, context, steadyDurationMs, true)
          const recovery = await runWindow(config, context, recoveryDurationMs, false)

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
              chaosEvents: Object.freeze([...steady.events, ...recovery.events]),
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
