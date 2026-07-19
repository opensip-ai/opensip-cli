/**
 * Review-brief RUNTIME (Plan 09 Phase 7). The ReviewBrief types, the
 * REVIEW_BRIEF_VERSION constant, and every `reviewBrief*Schema` zod schema
 * stay in @opensip-cli/contracts — schemas are the persisted-payload
 * validation contract MCP replays. This module owns only the executable
 * derivation shared by the CLI suite runner and the MCP replay port.
 */
import { compareCodePoint } from '@opensip-cli/contracts';
import { isErrorSeverity, isPlainRecord } from '@opensip-cli/core';

import {
  reviewBriefCorrelationKeys,
  reviewBriefEntities,
} from './review-brief-correlation-projection.js';

import type {
  DeriveReviewBriefVerdictInput,
  ReviewBrief,
  ReviewBriefBaselineDelta,
  ReviewBriefBaselineState,
  ReviewBriefBlastRadius,
  ReviewBriefDegradation,
  ReviewBriefRecommendedAction,
  ReviewBriefRisk,
  ReviewBriefVerdict,
  SignalToReviewBriefRiskInput,
} from '@opensip-cli/contracts';
import type { Signal, SignalSeverity } from '@opensip-cli/core';

const severityRank: Readonly<Record<SignalSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function compareNumber(left: number | undefined, right: number | undefined): number {
  return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
}

export function compareReviewBriefRisks(left: ReviewBriefRisk, right: ReviewBriefRisk): number {
  const severity = severityRank[left.severity] - severityRank[right.severity];
  if (severity !== 0) return severity;

  if (left.isNew !== right.isNew) return left.isNew ? -1 : 1;

  const leftDependents = left.blastRadius?.dependents ?? 0;
  const rightDependents = right.blastRadius?.dependents ?? 0;
  if (leftDependents !== rightDependents) return rightDependents - leftDependents;

  const source = compareCodePoint(left.source, right.source);
  if (source !== 0) return source;

  const file = compareCodePoint(left.file, right.file);
  if (file !== 0) return file;

  const line = compareNumber(left.line, right.line);
  if (line !== 0) return line;

  const column = compareNumber(left.column, right.column);
  if (column !== 0) return column;

  const rule = compareCodePoint(left.ruleId, right.ruleId);
  if (rule !== 0) return rule;

  const fingerprint = compareCodePoint(
    left.signalRef.fingerprint ?? '',
    right.signalRef.fingerprint ?? '',
  );
  if (fingerprint !== 0) return fingerprint;

  const stepIndex = left.signalRef.stepIndex - right.signalRef.stepIndex;
  if (stepIndex !== 0) return stepIndex;

  return left.signalRef.signalIndex - right.signalRef.signalIndex;
}

export function deriveReviewBriefVerdict(input: DeriveReviewBriefVerdictInput): ReviewBriefVerdict {
  const risks = input.risks ?? [];
  if (risks.some((risk) => isErrorSeverity(risk.severity))) return 'fail';
  if (risks.length > 0 || (input.degraded?.length ?? 0) > 0) return 'warn';
  return 'pass';
}

export function reviewBriefBaselineState(signal: Signal): ReviewBriefBaselineState | undefined {
  const raw = signal.metadata.baselineState;
  if (raw === 'added' || raw === 'new') return 'added';
  if (raw === 'unchanged' || raw === 'existing') return 'unchanged';
  const baseline = signal.metadata.baseline;
  if (isPlainRecord(baseline)) {
    const state = baseline.state;
    if (state === 'added' || state === 'new') return 'added';
    if (state === 'unchanged' || state === 'existing') return 'unchanged';
  }
  return undefined;
}

export function reviewBriefBlastRadius(signal: Signal): ReviewBriefBlastRadius | undefined {
  const raw = signal.metadata.blastRadius;
  if (!isPlainRecord(raw)) return undefined;
  const dependents = optionalNonNegativeInteger(raw.dependents);
  const confidence = raw.confidence;
  if (
    dependents === undefined ||
    (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high')
  ) {
    return undefined;
  }
  const impactedFiles = optionalNonNegativeInteger(raw.impactedFiles);
  return {
    dependents,
    confidence,
    ...(impactedFiles === undefined ? {} : { impactedFiles }),
  };
}

export function signalToReviewBriefRisk(input: SignalToReviewBriefRiskInput): ReviewBriefRisk {
  const state = reviewBriefBaselineState(input.signal);
  const fingerprint = input.signal.fingerprint;
  const signalBlastRadius = reviewBriefBlastRadius(input.signal);
  const entities = reviewBriefEntities(input.signal);
  const correlationKeys = reviewBriefCorrelationKeys(input.signal, entities);
  return {
    source: input.tool,
    ruleId: input.signal.ruleId,
    message: input.signal.message,
    severity: input.signal.severity,
    file: input.signal.filePath,
    ...(optionalPositiveInteger(input.signal.line) === undefined
      ? {}
      : { line: input.signal.line }),
    ...(optionalNonNegativeInteger(input.signal.column) === undefined
      ? {}
      : { column: input.signal.column }),
    isNew: state === 'added',
    signalRef: {
      tool: input.tool,
      suiteRunId: input.suiteRunId,
      stepIndex: input.stepIndex,
      runId: input.runId,
      ...(fingerprint === undefined ? {} : { fingerprint }),
      signalIndex: input.signalIndex,
    },
    ...(input.signal.repair === undefined ? {} : { repair: input.signal.repair }),
    ...(signalBlastRadius === undefined ? {} : { blastRadius: signalBlastRadius }),
    ...(entities.length === 0 ? {} : { entities }),
    ...(correlationKeys.length === 0 ? {} : { correlationKeys }),
  };
}

export function buildReviewBriefBaselineDelta(
  risks: readonly ReviewBriefRisk[],
  baselineStates: readonly ReviewBriefBaselineState[],
): ReviewBriefBaselineDelta {
  if (baselineStates.length === 0) {
    return {
      available: false,
      added: 0,
      removed: 0,
      unchanged: 0,
    };
  }
  return {
    available: true,
    added: risks.filter((risk) => risk.isNew).length,
    removed: 0,
    unchanged: baselineStates.filter((state) => state === 'unchanged').length,
  };
}

export function buildReviewBriefRecommendedActions(input: {
  readonly verdict: ReviewBrief['verdict'];
  readonly degraded: readonly ReviewBriefDegradation[];
  readonly risks: readonly ReviewBriefRisk[];
}): readonly ReviewBriefRecommendedAction[] {
  if (input.verdict === 'pass') return [];
  const actions: ReviewBriefRecommendedAction[] = [];
  if (input.risks.some((risk) => risk.severity === 'critical' || risk.severity === 'high')) {
    actions.push({
      priority: 'high',
      source: 'suite',
      message: 'Review and fix the error-severity top risks before merging.',
    });
  } else if (input.risks.length > 0) {
    actions.push({
      priority: 'medium',
      source: 'suite',
      message: 'Review the warning-severity top risks before relying on the suite result.',
    });
  }
  if (input.degraded.length > 0) {
    actions.push({
      priority: input.verdict === 'fail' ? 'medium' : 'high',
      source: 'suite',
      message: 'Resolve degraded suite evidence and rerun the suite.',
    });
  }
  return actions;
}

export function pushReviewBriefDegradation(
  degraded: ReviewBriefDegradation[],
  entry: ReviewBriefDegradation,
  limit: number,
): void {
  if (degraded.length >= limit) return;
  degraded.push(entry);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
