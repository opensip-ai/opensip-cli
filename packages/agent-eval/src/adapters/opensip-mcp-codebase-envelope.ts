import { isUnknownRecord as isRecord } from '../model/value-helpers.js';

import type { StepCoverage, StepFreshness } from '../model/record.js';

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return undefined;
  return value as string[];
}

export function extractCodebaseCoverage(
  payload: Readonly<Record<string, unknown>>,
): StepCoverage | undefined {
  if (!isRecord(payload.coverage)) return undefined;
  const coverage = payload.coverage;
  const reasons = readStringArray(coverage.reasonCodes);
  if (
    (coverage.status !== 'complete' &&
      coverage.status !== 'partial' &&
      coverage.status !== 'unavailable') ||
    reasons === undefined ||
    !Number.isSafeInteger(coverage.observed) ||
    (coverage.observed as number) < 0
  ) {
    return undefined;
  }
  if (
    coverage.status === 'complete' &&
    (!Number.isSafeInteger(coverage.total) ||
      (coverage.total as number) < (coverage.observed as number))
  ) {
    return undefined;
  }
  return {
    complete: coverage.status === 'complete',
    hardCapReasons: reasons,
    truncated: reasons.some((reason) => reason.includes('cap')),
  };
}

export function extractCodebaseFreshness(
  payload: Readonly<Record<string, unknown>>,
): StepFreshness | undefined {
  if (!isRecord(payload.freshness)) return undefined;
  const freshness = payload.freshness;
  const reasonCodes = readStringArray(freshness.reasonCodes);
  if (
    typeof freshness.fresh !== 'boolean' ||
    typeof freshness.capturedAt !== 'string' ||
    freshness.capturedAt.length === 0 ||
    (freshness.verification !== 'complete' &&
      freshness.verification !== 'missing' &&
      freshness.verification !== 'partial') ||
    reasonCodes === undefined ||
    (freshness.fresh && freshness.verification !== 'complete')
  ) {
    return undefined;
  }
  return {
    fresh: freshness.fresh,
    ...(reasonCodes[0] === undefined ? {} : { reasonCode: reasonCodes[0] }),
    verification: freshness.verification,
  };
}

export function codebaseContextIsValid(
  payload: Readonly<Record<string, unknown>>,
  coverage: StepCoverage | undefined,
  freshness: StepFreshness | undefined,
): boolean {
  const status = payload.status;
  if (
    (status !== 'found' &&
      status !== 'excluded' &&
      status !== 'unknown' &&
      status !== 'unavailable') ||
    typeof payload.inventoryIdentity !== 'string' ||
    payload.inventoryIdentity.length === 0 ||
    !isRecord(payload.project) ||
    readStringArray(payload.reasonCodes) === undefined ||
    readStringArray(payload.nextActions) === undefined ||
    coverage === undefined ||
    freshness === undefined
  ) {
    return false;
  }
  return (
    status !== 'found' ||
    (isRecord(payload.file) &&
      typeof payload.file.path === 'string' &&
      payload.file.path.length > 0)
  );
}
