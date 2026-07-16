import { factMatches } from '../model/argument-resolution.js';

import { hasRelevantAbsenceProof } from './negative-proof.js';

import type { ArmRunRecord, StepRecord } from '../model/record.js';
import type {
  AnswerAssertions,
  AnswerFact,
  AnswerFactPattern,
  RunLeg,
  ScopedAnswerAssertions,
} from '../model/task.js';

/** The positive or negative semantic contract represented by an outcome. */
export type AssertionKind = 'must-exclude' | 'must-include';
/** Classification of post-edit evidence returned by staleness scoring. */
export type StalenessVerdict =
  'fresh' | 'honestly-degraded' | 'inconclusive' | 'stale-served-as-fresh';

/** Pass/fail result for one fact expectation in one run leg. */
export interface AssertionOutcome {
  readonly expectation: AnswerFactPattern;
  readonly kind: AssertionKind;
  readonly leg: RunLeg;
  readonly passed: boolean;
}

/** Aggregated assertion outcomes for one run leg. */
export interface ScopedAssertionResult {
  readonly leg: RunLeg;
  readonly outcomes: readonly AssertionOutcome[];
  readonly passed: boolean;
}

/** Primary and recovery verdicts for a catalog-staleness experiment. */
export interface StalenessResult {
  readonly postEditPassed: boolean;
  readonly recoveryPassed?: boolean;
  readonly verdict: StalenessVerdict;
}

/** Complete arm-agnostic semantic scoring result for an arm run. */
export interface AssertionResult {
  readonly incorrectNone: number;
  readonly passed: boolean;
  readonly scopes: readonly ScopedAssertionResult[];
  readonly staleness?: StalenessResult;
}

function stepsForLeg(record: ArmRunRecord, leg: RunLeg): readonly StepRecord[] {
  return record.legs.filter((entry) => entry.leg === leg).flatMap((entry) => entry.steps);
}

function evaluateInclude(
  pattern: AnswerFactPattern,
  facts: readonly AnswerFact[],
  leg: RunLeg,
): AssertionOutcome {
  return {
    expectation: pattern,
    kind: 'must-include',
    leg,
    passed: facts.some((fact) => factMatches(pattern, fact)),
  };
}

function evaluateExclude(
  pattern: AnswerFactPattern,
  facts: readonly AnswerFact[],
  steps: readonly StepRecord[],
  leg: RunLeg,
): AssertionOutcome {
  const absent = !facts.some((fact) => factMatches(pattern, fact));
  return {
    expectation: pattern,
    kind: 'must-exclude',
    leg,
    passed: absent && hasRelevantAbsenceProof(steps, pattern),
  };
}

function evaluateScope(
  record: ArmRunRecord,
  assertions: ScopedAnswerAssertions,
): ScopedAssertionResult {
  const steps = stepsForLeg(record, assertions.leg);
  const facts = steps.filter((step) => step.failure === undefined).flatMap((step) => step.facts);
  const includes = (assertions.mustInclude ?? []).map((pattern) =>
    evaluateInclude(pattern, facts, assertions.leg),
  );
  const excludes = (assertions.mustExclude ?? []).map((pattern) =>
    evaluateExclude(pattern, facts, steps, assertions.leg),
  );
  const outcomes = [...includes, ...excludes];
  return {
    leg: assertions.leg,
    outcomes,
    passed: outcomes.every((outcome) => outcome.passed),
  };
}

function ordinaryScope(assertions: AnswerAssertions): ScopedAnswerAssertions | undefined {
  if (assertions.mustInclude === undefined && assertions.mustExclude === undefined) {
    return undefined;
  }
  return {
    leg: 'main',
    mustExclude: assertions.mustExclude,
    mustInclude: assertions.mustInclude,
  };
}

function claimsCompleteFreshEvidence(steps: readonly StepRecord[]): boolean {
  return (
    steps.length > 0 &&
    steps.every(
      (step) =>
        step.failure === undefined &&
        step.completeness === 'complete' &&
        !step.truncated &&
        step.coverage?.complete !== false &&
        (step.freshness === undefined ||
          (step.freshness.fresh && step.freshness.verification === 'complete')),
    )
  );
}

function findScope(
  scopes: readonly ScopedAssertionResult[],
  leg: RunLeg,
): ScopedAssertionResult | undefined {
  return scopes.find((scope) => scope.leg === leg);
}

function evaluateStaleness(
  record: ArmRunRecord,
  assertions: AnswerAssertions,
  scopes: readonly ScopedAssertionResult[],
): StalenessResult | undefined {
  const staleness = assertions.staleness;
  if (staleness === undefined) return undefined;

  const postEdit = findScope(scopes, staleness.postEditLeg);
  const postEditSteps = stepsForLeg(record, staleness.postEditLeg);
  let verdict: StalenessVerdict = 'inconclusive';
  if (postEdit?.passed === true && postEdit.outcomes.length > 0) {
    verdict = claimsCompleteFreshEvidence(postEditSteps) ? 'fresh' : 'honestly-degraded';
  } else if (
    postEdit !== undefined &&
    postEdit.outcomes.length > 0 &&
    postEditSteps.some((step) => step.failure === undefined)
  ) {
    verdict = claimsCompleteFreshEvidence(postEditSteps)
      ? 'stale-served-as-fresh'
      : 'honestly-degraded';
  }

  const recoverySteps =
    staleness.recoveryLeg === undefined ? [] : stepsForLeg(record, staleness.recoveryLeg);
  const recovery =
    staleness.recoveryLeg === undefined || recoverySteps.length === 0
      ? undefined
      : (findScope(scopes, staleness.recoveryLeg)?.passed ?? false) &&
        stepContractsPass(recoverySteps) &&
        claimsCompleteFreshEvidence(recoverySteps);
  return {
    postEditPassed: postEdit?.passed === true && postEdit.outcomes.length > 0,
    recoveryPassed: recovery,
    verdict,
  };
}

function countIncorrectNone(record: ArmRunRecord): number {
  return record.legs
    .filter((leg) => leg.leg !== 'recovery')
    .flatMap((leg) => leg.steps)
    .filter((step) => step.expectedNonEmpty && step.noneOutcome === 'empty-complete').length;
}

function expectedEvidenceSatisfied(record: ArmRunRecord): boolean {
  const steps = record.legs.filter((leg) => leg.leg !== 'recovery').flatMap((leg) => leg.steps);
  return stepContractsPass(steps);
}

function stepContractsPass(steps: readonly StepRecord[]): boolean {
  return steps.every((step) => !step.expectedNonEmpty || step.noneOutcome === 'nonempty');
}

/** Score normalized facts without branching on the arm that produced them. */
export function evaluateAssertions(
  record: ArmRunRecord,
  assertions: AnswerAssertions,
): AssertionResult {
  const ordinary = ordinaryScope(assertions);
  const requestedScopes = [
    ...(ordinary === undefined ? [] : [ordinary]),
    ...(assertions.scoped ?? []),
  ];
  const scopes = requestedScopes
    .filter((scope) => scope.leg !== 'recovery' || stepsForLeg(record, 'recovery').length > 0)
    .map((scope) => evaluateScope(record, scope));
  const incorrectNone = countIncorrectNone(record);
  const staleness = evaluateStaleness(record, assertions, scopes);
  return {
    incorrectNone,
    passed:
      scopes.filter((scope) => scope.leg !== 'recovery').every((scope) => scope.passed) &&
      incorrectNone === 0 &&
      expectedEvidenceSatisfied(record),
    scopes,
    staleness,
  };
}
