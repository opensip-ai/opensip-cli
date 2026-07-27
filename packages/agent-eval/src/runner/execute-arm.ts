import { resolveStepArguments } from '../model/argument-resolution.js';
import { makeStepRecord, type ArmLegRecord, type ToolInvoker } from '../model/record.js';
import {
  type ResolvedStrategyStep,
  type RunLeg,
  type ScopedAnswerAssertions,
  type StrategyStep,
} from '../model/task.js';
import {
  appendStepRecord,
  canAnswer,
  createAnswerState,
  type AnswerState,
} from '../scorer/answer-state.js';

import { safeErrorDetail } from './error-detail.js';

/** Dependencies and semantic contract for executing one strategy leg. */
export interface ExecuteArmInput {
  /** Assertions for this leg only. They drive goal-directed early exit. */
  readonly assertions: ScopedAnswerAssertions;
  /** The arm-bound tool effect. Adapter selection stays outside this loop. */
  readonly invoker: ToolInvoker;
  /** Defaults to the assertion scope and is stamped onto every invocation. */
  readonly leg?: RunLeg;
  /** Paths removed from any rejected-invocation detail before it becomes durable. */
  readonly sensitivePaths?: readonly string[];
  readonly steps: readonly StrategyStep[];
}

/**
 * Resolve the leg shared by assertions and strategy execution.
 *
 * @throws {Error} When an explicit execution leg conflicts with the assertion leg.
 */
function effectiveLeg(input: ExecuteArmInput): RunLeg {
  const leg = input.leg ?? input.assertions.leg;
  if (input.assertions.leg !== leg) {
    throw new Error(`Cannot execute ${leg} steps with ${input.assertions.leg} assertions.`);
  }
  return leg;
}

/**
 * Stamp an unscoped step with its execution leg.
 *
 * @throws {Error} When a step is already scoped to a different leg.
 */
function scopeStep(step: StrategyStep, leg: RunLeg): StrategyStep {
  if (step.leg !== undefined && step.leg !== leg) {
    throw new Error(`Cannot execute ${step.leg} step ${step.id} in the ${leg} leg.`);
  }
  return { ...step, leg };
}

function bindingFailureRecord(step: StrategyStep, leg: RunLeg, state: AnswerState) {
  const startedAt = performance.now();
  const resolution = resolveStepArguments(step, state.observations);
  if (resolution.ok) return resolution;

  return {
    ok: false as const,
    record: makeStepRecord({
      failure: {
        code: resolution.failure.code,
        kind: 'binding',
        message: resolution.failure.message,
      },
      leg,
      renderedResponse: '',
      step: {
        ...step,
        arguments: {},
        expectedNonEmpty: step.expectedNonEmpty ?? false,
      },
      wallMs: Math.max(0, performance.now() - startedAt),
    }),
  };
}

async function invokeStep(input: ExecuteArmInput, step: ResolvedStrategyStep, leg: RunLeg) {
  const startedAt = performance.now();
  try {
    return await input.invoker(step);
  } catch (error) {
    return makeStepRecord({
      failure: {
        code: 'tool-invocation-failure',
        kind: 'infrastructure',
        message: safeErrorDetail(error, input.sensitivePaths) || 'Tool invocation failed.',
      },
      leg,
      renderedResponse: '',
      step,
      wallMs: Math.max(0, performance.now() - startedAt),
    });
  }
}

/**
 * Execute one strategy leg in order. Every call owns a fresh append-only answer
 * state; only normalized facts from earlier steps in this call can bind later
 * arguments. @sequential-ok Each bounded step can depend on prior response facts,
 * and early exit must stop before later calls are issued.
 */
export async function executeArm(input: ExecuteArmInput): Promise<ArmLegRecord> {
  const leg = effectiveLeg(input);
  let state = createAnswerState(leg);

  for (const candidate of input.steps) {
    const step = scopeStep(candidate, leg);
    const resolution = bindingFailureRecord(step, leg, state);
    const record = resolution.ok
      ? await invokeStep(input, resolution.step, leg)
      : resolution.record;
    state = appendStepRecord(state, record);
    if (canAnswer(state, input.assertions)) break;
  }

  return { leg, steps: state.steps };
}
