// @fitness-ignore-file null-safety -- ScenarioResultBuilder.create() returns a fluent builder; chained method calls are always safe
// @fitness-ignore-file array-validation -- array parameters validated at API boundary
// @fitness-ignore-file detached-promises -- ScenarioResultBuilder fluent calls and runLoadWindow delegate are synchronous outside their awaited boundaries
/**
 * @fileoverview Load-kind executor.
 *
 * Delegates to the shared `runLoadWindow` driver in
 * `framework/execution/run-load-window.ts` — the load kind is the
 * "default" version of the loop (no per-tick chaos injection).
 */

import { ScenarioAbortedError } from '../../framework/execution/execution-engine.js'
import { runLoadWindow } from '../../framework/execution/run-load-window.js'
import { ScenarioResultBuilder } from '../../framework/result-builder.js'
import { createScenarioLogger } from '../../framework/scenario-logger.js'

import type { LoadScenarioConfig } from './config.js'
import type { RunnableScenario } from '../../framework/runnable-scenario.js'
import type {
  LoadScenarioExecutorResult,
} from '../../framework/scenario-executor-result.js'
import type {
  ScenarioExecutionContext,
} from '../../types/framework-types.js'

// =============================================================================
// STANDARD EXECUTOR (mock simulation loop)
// =============================================================================

/**
 * Build the standard self-contained executor for load scenarios without a
 * custom `execute` function. Delegates the tick loop to `runLoadWindow`
 * and wraps the result into the kind-specific envelope.
 */
function createStandardExecutor(
  config: LoadScenarioConfig,
): (context: ScenarioExecutionContext) => Promise<LoadScenarioExecutorResult> {
  return async (context) => {
    const startTime = Date.now()
    context.logger.info('Starting standard load scenario execution', {
      duration: config.duration,
      personas: config.personas.length,
      targetRps: config.targetRps,
    })

    const window = await runLoadWindow(config, context, {
      windowMs: config.duration * 1000,
    })

    const built = ScenarioResultBuilder.create(config.id)
      .withMetrics(window.metrics)
      .withDuration(config.duration)
      .evaluateAssertions(config.assertions)
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
