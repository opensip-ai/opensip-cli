import { factMatches } from '../model/argument-resolution.js';

import { hasRelevantAbsenceProof } from './negative-proof.js';

import type { StepRecord } from '../model/record.js';
import type { FactObservation, RunLeg, ScopedAnswerAssertions } from '../model/task.js';

/** Immutable, append-only observations for exactly one run leg. */
export interface AnswerState {
  readonly leg: RunLeg;
  readonly observations: readonly FactObservation[];
  readonly steps: readonly StepRecord[];
}

/** Create an empty immutable answer state for one run leg. */
export function createAnswerState(leg: RunLeg): AnswerState {
  return { leg, observations: [], steps: [] };
}

/** Discard prior observations and start an empty state for a new run leg. */
export function resetAnswerState(_state: AnswerState, leg: RunLeg): AnswerState {
  return createAnswerState(leg);
}

/**
 * Append a step and its usable facts without mutating the prior answer state.
 *
 * @throws {Error} When the step belongs to a different run leg than the state.
 */
export function appendStepRecord(state: AnswerState, step: StepRecord): AnswerState {
  if (state.leg !== step.leg) {
    throw new Error(`Cannot append a ${step.leg} step to ${state.leg} answer state.`);
  }
  const firstOrdinal = state.observations.length;
  const usableFacts = step.failure === undefined ? step.facts : [];
  const observations = usableFacts.map((fact, index) => ({
    fact,
    leg: step.leg,
    ordinal: firstOrdinal + index,
    stepId: step.stepId,
  }));
  return {
    leg: state.leg,
    observations: [...state.observations, ...observations],
    steps: [...state.steps, step],
  };
}

function stepExpectationsPass(state: AnswerState): boolean {
  return state.steps.every((step) => !step.expectedNonEmpty || step.noneOutcome === 'nonempty');
}

/**
 * True once the current leg contains sufficient facts to answer. Negative-only
 * assertions require a complete response so absence is not confused with a
 * truncated or failed result.
 */
export function canAnswer(state: AnswerState, assertions: ScopedAnswerAssertions): boolean {
  if (state.leg !== assertions.leg || state.steps.length === 0) return false;

  const facts = state.observations.map((observation) => observation.fact);
  const includes = assertions.mustInclude ?? [];
  const excludes = assertions.mustExclude ?? [];
  const allIncluded = includes.every((pattern) => facts.some((fact) => factMatches(pattern, fact)));
  const noneExcluded = excludes.every(
    (pattern) => !facts.some((fact) => factMatches(pattern, fact)),
  );
  const absenceIsProven = excludes.every((pattern) =>
    hasRelevantAbsenceProof(state.steps, pattern),
  );

  return allIncluded && noneExcluded && absenceIsProven && stepExpectationsPass(state);
}
