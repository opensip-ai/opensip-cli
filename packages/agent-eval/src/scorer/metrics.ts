import { factMatches } from '../model/argument-resolution.js';

import { hasRelevantAbsenceProof } from './negative-proof.js';

import type { ArmRunRecord, StepRecord } from '../model/record.js';
import type { AnswerAssertions, RunLeg, ScopedAnswerAssertions } from '../model/task.js';

/** Primary call, byte, timing, and false-none cost for one arm run. */
export interface ArmMetrics {
  readonly callCount: number;
  readonly incorrectNone: number;
  readonly responseBytes: number;
  readonly timeToFirstUsefulContextMs: number | null;
  readonly totalWallMs: number;
}

/** Recovery-only cost kept separate from the primary arm metrics. */
export interface RecoveryMetrics {
  readonly callCount: number;
  readonly responseBytes: number;
  readonly totalWallMs: number;
}

function primarySteps(record: ArmRunRecord): readonly StepRecord[] {
  return record.legs.filter((entry) => entry.leg !== 'recovery').flatMap((entry) => entry.steps);
}

function assertionsForLeg(
  assertions: AnswerAssertions,
  leg: RunLeg,
): ScopedAnswerAssertions | undefined {
  if (leg === 'main') {
    const ordinaryIsPresent =
      assertions.mustInclude !== undefined || assertions.mustExclude !== undefined;
    if (ordinaryIsPresent) {
      return {
        leg,
        mustExclude: assertions.mustExclude,
        mustInclude: assertions.mustInclude,
      };
    }
  }
  return assertions.scoped?.find((scope) => scope.leg === leg);
}

function providesUsefulContext(
  step: StepRecord,
  sameLegPrefix: readonly StepRecord[],
  assertions: ScopedAnswerAssertions | undefined,
): boolean {
  if (step.failure !== undefined) return false;
  if (assertions === undefined) return false;
  const positiveMatch = (assertions.mustInclude ?? []).some((pattern) =>
    step.facts.some((fact) => factMatches(pattern, fact)),
  );
  if (positiveMatch) return true;

  const negativePatterns = assertions.mustExclude ?? [];
  const prefixFacts = sameLegPrefix
    .filter((candidate) => candidate.failure === undefined)
    .flatMap((candidate) => candidate.facts);
  const prefixContractsPass = sameLegPrefix.every(
    (candidate) => !candidate.expectedNonEmpty || candidate.noneOutcome === 'nonempty',
  );
  const negativeProof =
    prefixContractsPass &&
    negativePatterns.length > 0 &&
    negativePatterns.every(
      (pattern) =>
        !prefixFacts.some((fact) => factMatches(pattern, fact)) &&
        hasRelevantAbsenceProof(sameLegPrefix, pattern),
    );
  if (negativeProof) return true;

  return false;
}

function firstUsefulContextMs(
  steps: readonly StepRecord[],
  assertions: AnswerAssertions,
): number | null {
  const answerLeg: RunLeg = assertions.staleness?.postEditLeg ?? 'main';
  let elapsed = 0;
  const sameLegPrefix: StepRecord[] = [];
  for (const step of steps) {
    elapsed += step.wallMs;
    if (step.leg === answerLeg) sameLegPrefix.push(step);
    if (
      step.leg === answerLeg &&
      providesUsefulContext(step, sameLegPrefix, assertionsForLeg(assertions, step.leg))
    ) {
      return elapsed;
    }
  }
  return null;
}

/** Compute primary arm cost through the first answerable context. */
export function computeArmMetrics(record: ArmRunRecord, assertions: AnswerAssertions): ArmMetrics {
  const steps = primarySteps(record);
  return {
    callCount: steps.length,
    incorrectNone: steps.filter(
      (step) => step.expectedNonEmpty && step.noneOutcome === 'empty-complete',
    ).length,
    responseBytes: steps.reduce((total, step) => total + step.responseBytes, 0),
    timeToFirstUsefulContextMs: firstUsefulContextMs(steps, assertions),
    totalWallMs: steps.reduce((total, step) => total + step.wallMs, 0),
  };
}

/** Recovery cost is reported separately and never contaminates primary cost. */
export function computeRecoveryMetrics(record: ArmRunRecord): RecoveryMetrics {
  const steps = record.legs
    .filter((entry) => entry.leg === 'recovery')
    .flatMap((entry) => entry.steps);
  return {
    callCount: steps.length,
    responseBytes: steps.reduce((total, step) => total + step.responseBytes, 0),
    totalWallMs: steps.reduce((total, step) => total + step.wallMs, 0),
  };
}
