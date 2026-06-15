/**
 * @fileoverview Chaos-kind executor.
 *
 * Composes the real `runLoadWindow` driver with the client-side fault model:
 * a steady-state window drives the BYO `target` wrapped by the fault model
 * (latency/abort/drop injected at the configured probability), then a recovery
 * window drives the bare target with faults lifted. Each window's measured
 * metrics are scored against its assertion set; the scenario passes iff both
 * windows hold.
 */

import { ScenarioAbortedError } from '../../framework/execution/execution-engine.js';
import { createFaultModel } from '../../framework/execution/fault-model.js';
import { runLoadWindow } from '../../framework/execution/run-load-window.js';
import {
  buildFailedScenarioSignal,
  ScenarioResultBuilder,
} from '../../framework/result-builder.js';
import { createScenarioLogger } from '../../framework/scenario-logger.js';

import type { ChaosScenarioConfig } from './config.js';
import type { ChaosAssertionVerdict, ChaosEvent } from './result.js';
import type { FaultModelDeps } from '../../framework/execution/fault-model.js';
import type { RunnableScenario } from '../../framework/runnable-scenario.js';
import type { ChaosScenarioExecutorResult } from '../../framework/scenario-executor-result.js';
import type { SimulationMetrics } from '../../types/base-types.js';
import type { ScenarioExecutionContext } from '../../types/framework-types.js';

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
    .build();
  return {
    passed: built.assertions.passed,
    failed: built.assertions.failed,
  };
}

/**
 * Build a `RunnableScenario` for a chaos-kind config.
 *
 * `deps.rng` is forwarded to the fault model so tests can drive the
 * probability gate deterministically; production defaults to `Math.random`.
 */
export function createChaosScenarioRunner(
  config: ChaosScenarioConfig,
  deps: FaultModelDeps = {},
): RunnableScenario {
  return Object.freeze({
    kind: 'chaos' as const,
    id: config.id,
    name: config.name,
    description: config.description,
    tags: Object.freeze([...config.tags]),

    run:
      /** @throws {ScenarioAbortedError} When the scenario is aborted via AbortSignal */
      async (abortSignal: AbortSignal): Promise<ChaosScenarioExecutorResult> => {
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

        const startTime = Date.now();
        try {
          const faultModel = createFaultModel(config.fault, deps);

          // Steady-state window: drive the fault-decorated target.
          const steadyStart = Date.now();
          const steady = await runLoadWindow({ workload: config.workload }, context, {
            windowMs: config.duration * 1000,
            target: faultModel.wrap(config.target),
          });

          // Recovery window: faults lifted — drive the bare target.
          const recovery = await runLoadWindow({ workload: config.workload }, context, {
            windowMs: config.recoveryWindow,
            target: config.target,
          });

          const steadyVerdict = evaluateAssertionsForWindow(
            config.id,
            steady.metrics,
            config.duration,
            config.steadyStateAssertions,
          );
          const recoveryVerdict = evaluateAssertionsForWindow(
            config.id,
            recovery.metrics,
            config.recoveryWindow / 1000,
            config.recoveryAssertions,
          );

          const failedAssertions = [...steadyVerdict.failed, ...recoveryVerdict.failed];
          const passed = failedAssertions.length === 0;

          const chaosEvents: readonly ChaosEvent[] = Object.freeze(
            faultModel.drained().map((f) =>
              Object.freeze({
                type: f.kind,
                atMs: Math.max(0, f.at - steadyStart),
                target: 'client',
              }),
            ),
          );

          return Object.freeze({
            kind: 'chaos' as const,
            scenarioId: config.id,
            passed,
            durationMs: Date.now() - startTime,
            // ADR-0035: surface a failed chaos scenario in the signal currency
            // (steady- and recovery-window assertion failures), so the host
            // verdict sees it. The load path emits via build(); chaos builds its
            // own payload, so it must emit here.
            signals: passed
              ? Object.freeze([] as const)
              : Object.freeze([buildFailedScenarioSignal(config.id, failedAssertions)]),
            outcome: Object.freeze({
              steadyStateMetrics: steady.metrics,
              recoveryMetrics: recovery.metrics,
              steadyStateAssertions: steadyVerdict,
              recoveryAssertions: recoveryVerdict,
              chaosEvents,
              recoveryWindowMs: config.recoveryWindow,
            }),
          });
        } catch (error) {
          if (abortSignal.aborted) {
            throw new ScenarioAbortedError(config.id);
          }
          throw error;
        }
      },
  });
}
