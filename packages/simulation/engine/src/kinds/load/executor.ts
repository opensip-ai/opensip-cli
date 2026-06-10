// @fitness-ignore-file null-safety -- ScenarioResultBuilder.create() returns a fluent builder; chained method calls are always safe
// @fitness-ignore-file array-validation -- array parameters validated at API boundary
// @fitness-ignore-file detached-promises -- ScenarioResultBuilder fluent calls and runLoadWindow delegate are synchronous outside their awaited boundaries
/**
 * @fileoverview Load-kind executor.
 *
 * Drives the BYO `target` through the shared `runLoadWindow` driver at the
 * configured `workload`, then scores the measured metrics against the
 * scenario's assertions. The load kind is the "default" version of the loop
 * (no fault injection).
 */

import { ScenarioAbortedError } from '../../framework/execution/execution-engine.js';
import { runLoadWindow } from '../../framework/execution/run-load-window.js';
import { ScenarioResultBuilder } from '../../framework/result-builder.js';
import { createScenarioLogger } from '../../framework/scenario-logger.js';

import type { LoadScenarioConfig } from './config.js';
import type { RunnableScenario } from '../../framework/runnable-scenario.js';
import type { LoadScenarioExecutorResult } from '../../framework/scenario-executor-result.js';
import type { ScenarioExecutionContext } from '../../types/framework-types.js';

/**
 * Run the load window against the BYO target and wrap the measured metrics +
 * assertion verdicts into the kind-specific envelope.
 */
async function executeLoad(
  config: LoadScenarioConfig,
  context: ScenarioExecutionContext,
): Promise<LoadScenarioExecutorResult> {
  const startTime = Date.now();
  context.logger.info('Starting load scenario execution', {
    duration: config.duration,
    rps: config.workload.rps,
  });

  const window = await runLoadWindow({ workload: config.workload }, context, {
    windowMs: config.duration * 1000,
    target: config.target,
  });

  const built = ScenarioResultBuilder.create(config.id)
    .withMetrics(window.metrics)
    .withDuration(config.duration)
    .evaluateAssertions(config.assertions)
    .build();

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
  });
}

// =============================================================================
// RUNNABLE SCENARIO FACTORY
// =============================================================================

/**
 * Build a `RunnableScenario` for a load-kind config. The returned object is
 * frozen and carries `kind: 'load'`.
 */
export function createLoadScenarioRunner(config: LoadScenarioConfig): RunnableScenario {
  return Object.freeze({
    kind: 'load' as const,
    id: config.id,
    name: config.name,
    description: config.description,
    tags: Object.freeze([...config.tags]),

    run:
      /** @throws {ScenarioAbortedError} When the scenario is aborted via AbortSignal */
      async (abortSignal: AbortSignal): Promise<LoadScenarioExecutorResult> => {
        const correlationId = `scenario-${config.id}-${Date.now().toString(36)}`;

        const context: ScenarioExecutionContext = {
          scenarioId: config.id,
          correlationId,
          abortSignal,
          logger: createScenarioLogger(config.id),
        };

        if (abortSignal.aborted) {
          throw new ScenarioAbortedError(config.id);
        }

        try {
          return await executeLoad(config, context);
        } catch (error) {
          if (abortSignal.aborted) {
            throw new ScenarioAbortedError(config.id);
          }
          throw error;
        }
      },
  });
}
