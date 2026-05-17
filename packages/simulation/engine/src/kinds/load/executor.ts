// @fitness-ignore-file null-safety -- ScenarioResultBuilder.create() returns a fluent builder; chained method calls are always safe
// @fitness-ignore-file array-validation -- array parameters validated at API boundary
/**
 * @fileoverview Load-kind executor.
 *
 * Extracted from the legacy `define-scenario.ts` `createStandardExecutor` +
 * `createRunnableScenario` helpers. Behavior is preserved verbatim — load
 * scenarios authored against the new `defineLoadScenario` entry point produce
 * the same metrics, assertion bookkeeping, and signal stream as before.
 */

import { ScenarioAbortedError } from '../../framework/execution/execution-engine.js'
import { LatencyTracker } from '../../framework/execution/latency-tracker.js'
import { getEstimatedRps } from '../../framework/personas.js'
import { ScenarioResultBuilder, createEmptyMetrics } from '../../framework/result-builder.js'
import { createScenarioLogger } from '../../framework/scenario-logger.js'

import type { LoadScenarioConfig } from './define.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type {
  LoadScenarioExecutorResult,
} from '../../framework/scenario-executor-result.js'
import type { SimulationMetrics } from '../../types/base-types.js'
import type {
  ScenarioExecutionContext,
} from '../../types/framework-types.js'
import type { Signal } from '@opensip-tools/core'

// =============================================================================
// STANDARD EXECUTOR (mock simulation loop)
// =============================================================================

/**
 * Build the standard self-contained executor for load scenarios without a
 * custom `execute` function. Runs a mock simulation loop with random latency
 * and a 95% success rate.
 */
// @fitness-ignore-next-line file-length-limits -- Simulation executor: sequential phase orchestration (init, ramp, sustain, cooldown) requires contiguous control flow
function createStandardExecutor(
  config: LoadScenarioConfig,
): (context: ScenarioExecutionContext) => Promise<LoadScenarioExecutorResult> {
  return async (context) => {
    const startTime = Date.now()
    const targetRps = config.targetRps ?? getEstimatedRps(config.personas)
    context.logger.info('Starting standard load scenario execution', {
      duration: config.duration,
      personas: config.personas.length,
      targetRps,
    })

    const metrics: SimulationMetrics = createEmptyMetrics()
    const latencyTracker = new LatencyTracker()
    const signals: Signal[] = []
    const durationMs = config.duration * 1000
    const rampUpMs = (config.rampUp ?? 0) * 1000
    const tickIntervalMs = 100
    const loopStart = Date.now()

    while (Date.now() - loopStart < durationMs) {
      if (context.abortSignal.aborted) break

      const elapsed = Date.now() - loopStart
      const rampUpProgress = rampUpMs > 0 ? Math.min(1, elapsed / rampUpMs) : 1
      const currentRps = targetRps * rampUpProgress
      const requestsThisTick = Math.floor(currentRps / (1000 / tickIntervalMs))

      for (let i = 0; i < requestsThisTick; i++) {
        if (context.abortSignal.aborted) break

        // Simulate an action with random latency
        const latency = Math.random() * 50 + 1
        metrics.totalRequests++
        latencyTracker.record(latency)

        // 95% success rate by default
        if (Math.random() < 0.95) {
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

    const built = ScenarioResultBuilder.create(config.id)
      .withMetrics(metrics)
      .withDuration(config.duration)
      .evaluateAssertions(config.assertions)
      .addSignals(signals)
      .build()

    return Object.freeze({
      kind: 'load' as const,
      scenarioId: config.id,
      passed: built.passed,
      durationMs: Date.now() - startTime,
      signals: built.signals,
      outcome: Object.freeze({
        metrics: built.metrics,
        assertions: built.assertions,
      }),
    })
  }
}

/**
 * Build a custom executor for a load scenario that supplied its own `execute`
 * function. The custom function returns the legacy executor result shape;
 * we wrap it in the new discriminated `LoadScenarioExecutorResult`.
 *
 * @throws {ValidationError} When the execute function is not provided
 */
function createCustomExecutor(
  config: LoadScenarioConfig,
): (context: ScenarioExecutionContext) => Promise<LoadScenarioExecutorResult> {
  const customFn = config.execute
  if (!customFn) {
    // @fitness-ignore-next-line result-pattern-consistency -- internal factory function, exceptions propagate to caller
    throw new Error('execute function is required for custom executor')
  }

  return async (context) => {
    const startTime = Date.now()
    context.logger.info('Starting custom load scenario execution')
    const legacyResult = await customFn(context)
    return Object.freeze({
      kind: 'load' as const,
      scenarioId: config.id,
      passed: legacyResult.passed,
      durationMs: Date.now() - startTime,
      signals: legacyResult.signals,
      outcome: Object.freeze({
        metrics: legacyResult.metrics,
        assertions: legacyResult.assertions,
      }),
    })
  }
}

// =============================================================================
// RUNNABLE SCENARIO FACTORY
// =============================================================================

/**
 * Build a `RunnableScenario` for a load-kind config. The returned object is
 * frozen and carries `kind: 'load'`.
 */
export function createLoadScenarioRunner(config: LoadScenarioConfig): RunnableScenario {
  const executor = config.execute ? createCustomExecutor(config) : createStandardExecutor(config)

  return Object.freeze({
    kind: 'load' as const,
    id: config.id,
    name: config.name,
    description: config.description,
    tags: Object.freeze([...config.tags]),

    run:
      /** @throws {ScenarioAbortedError} When the scenario is aborted via AbortSignal */
      async (abortSignal: AbortSignal): Promise<LoadScenarioExecutorResult> => {
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

        try {
          return await executor(context)
        } catch (error) {
          if (abortSignal.aborted) {
            throw new ScenarioAbortedError(config.id)
          }
          throw error
        }
      },
  })
}
