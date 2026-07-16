import type { StepRecord } from '../model/record.js';
import type { AnswerFactPattern } from '../model/task.js';

function asRecord(value: AnswerFactPattern): Readonly<Record<string, unknown>> {
  return value;
}

/**
 * A broad declared proof domain covers a narrower assertion only when every
 * field declared by the proof is also present with the same value.
 */
export function proofCoversExpectation(
  proof: AnswerFactPattern,
  expectation: AnswerFactPattern,
): boolean {
  if (proof.kind !== expectation.kind) return false;
  const expected = asRecord(expectation);
  return Object.entries(proof).every(
    ([field, value]) => field === 'kind' || expected[field] === value,
  );
}

function requestedCoverageIsExhaustive(step: StepRecord): boolean {
  if (step.coverage === undefined) return true;
  if (!step.coverage.complete || step.coverage.truncated) return false;
  return (step.coverage.facets ?? []).every(
    (facet) => !facet.requested || (facet.complete && !facet.truncated),
  );
}

function stepIsExhaustive(step: StepRecord): boolean {
  return (
    step.failure === undefined &&
    step.completeness === 'complete' &&
    !step.truncated &&
    step.nextCursor === undefined &&
    requestedCoverageIsExhaustive(step) &&
    (step.freshness === undefined ||
      (step.freshness.fresh && step.freshness.verification === 'complete'))
  );
}

/**
 * Absence is evidence only when an exhaustive step declares this fact domain
 * and every earlier same-leg discovery step was transport-exhaustive and
 * projection-complete. The proof-bearing response must also attest semantic
 * domain exhaustion. This prevents a terminal search over a truncated, lossy,
 * or still-open response-derived frontier from certifying absence.
 */
export function hasRelevantAbsenceProof(
  steps: readonly StepRecord[],
  expectation: AnswerFactPattern,
): boolean {
  let exhaustivePrefix = true;
  let projectionPrefixComplete = true;
  for (const step of steps) {
    exhaustivePrefix &&= stepIsExhaustive(step);
    if (step.proofRelevance !== 'irrelevant') {
      projectionPrefixComplete &&= step.proofClosure?.projectionComplete === true;
    }
    if (
      exhaustivePrefix &&
      projectionPrefixComplete &&
      step.proofClosure?.domainExhausted === true &&
      step.absenceProofs.some((proof) => proofCoversExpectation(proof, expectation))
    ) {
      return true;
    }
  }
  return false;
}
