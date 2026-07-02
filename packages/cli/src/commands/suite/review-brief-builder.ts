import {
  REVIEW_BRIEF_VERSION,
  compareReviewBriefRisks,
  deriveReviewBriefVerdict,
  type ReviewBrief,
  type ReviewBriefBaselineDelta,
  type ReviewBriefBlastRadius,
  type ReviewBriefDegradation,
  type ReviewBriefRecommendedAction,
  type ReviewBriefRisk,
} from '@opensip-cli/contracts';
import { isPlainRecord, type Signal } from '@opensip-cli/core';

import {
  DEFAULT_REVIEW_BRIEF_DEGRADATION_LIMIT,
  DEFAULT_REVIEW_BRIEF_RISK_LIMIT,
  type SuiteStepReviewInput,
} from './review-brief.js';

export interface BuildReviewBriefInput {
  readonly suite: string;
  readonly suiteRunId: string;
  readonly steps: readonly SuiteStepReviewInput[];
  readonly changedFiles?: number | null;
  readonly riskLimit?: number;
  readonly degradationLimit?: number;
}

type BaselineState = 'added' | 'unchanged';

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function baselineState(signal: Signal): BaselineState | undefined {
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

function blastRadius(signal: Signal): ReviewBriefBlastRadius | undefined {
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

function signalToRisk(input: {
  readonly suiteRunId: string;
  readonly stepIndex: number;
  readonly signalIndex: number;
  readonly signal: Signal;
  readonly tool: string;
  readonly runId: string;
}): ReviewBriefRisk {
  const state = baselineState(input.signal);
  const fingerprint = input.signal.fingerprint;
  const signalBlastRadius = blastRadius(input.signal);
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
  };
}

function pushDegraded(
  degraded: ReviewBriefDegradation[],
  entry: ReviewBriefDegradation,
  limit: number,
): void {
  if (degraded.length >= limit) return;
  degraded.push(entry);
}

function collectRisks(input: {
  readonly suiteRunId: string;
  readonly steps: readonly SuiteStepReviewInput[];
  readonly degradationLimit: number;
}): {
  readonly risks: readonly ReviewBriefRisk[];
  readonly degraded: readonly ReviewBriefDegradation[];
  readonly baselineStates: readonly BaselineState[];
} {
  const risks: ReviewBriefRisk[] = [];
  const degraded: ReviewBriefDegradation[] = [];
  const baselineStates: BaselineState[] = [];

  for (const step of input.steps) {
    if (step.summary.error !== undefined) {
      pushDegraded(
        degraded,
        {
          source: step.summary.tool,
          reason: step.summary.error,
          code: 'step-fault',
          stepIndex: step.stepIndex,
        },
        input.degradationLimit,
      );
    }

    const envelope = step.capturedEnvelope;
    if (envelope === undefined) {
      pushDegraded(
        degraded,
        {
          source: step.summary.tool,
          reason: `Suite step '${step.summary.command}' did not emit a SignalEnvelope.`,
          code: 'missing-envelope',
          stepIndex: step.stepIndex,
        },
        input.degradationLimit,
      );
      continue;
    }

    if (!envelope.verdict.passed && envelope.signals.length === 0) {
      pushDegraded(
        degraded,
        {
          source: envelope.tool,
          reason: `Step '${step.summary.command}' reported a failing verdict without signals.`,
          code: 'failing-verdict-without-signals',
          stepIndex: step.stepIndex,
        },
        input.degradationLimit,
      );
    }

    const missingFingerprints = envelope.signals.filter((signal) => !signal.fingerprint).length;
    if (missingFingerprints > 0) {
      pushDegraded(
        degraded,
        {
          source: envelope.tool,
          reason: `${missingFingerprints} signal(s) were missing baseline fingerprints.`,
          code: 'missing-fingerprint',
          stepIndex: step.stepIndex,
        },
        input.degradationLimit,
      );
    }

    envelope.signals.forEach((signal, signalIndex) => {
      const state = baselineState(signal);
      if (state !== undefined) baselineStates.push(state);
      risks.push(
        signalToRisk({
          suiteRunId: input.suiteRunId,
          stepIndex: step.stepIndex,
          signalIndex,
          signal,
          tool: envelope.tool,
          runId: envelope.runId,
        }),
      );
    });
  }

  return { risks, degraded, baselineStates };
}

function baselineDelta(
  risks: readonly ReviewBriefRisk[],
  baselineStates: readonly BaselineState[],
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

function recommendedActions(input: {
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

export function buildReviewBrief(input: BuildReviewBriefInput): ReviewBrief {
  const riskLimit = input.riskLimit ?? DEFAULT_REVIEW_BRIEF_RISK_LIMIT;
  const degradationLimit = input.degradationLimit ?? DEFAULT_REVIEW_BRIEF_DEGRADATION_LIMIT;
  const collected = collectRisks({
    suiteRunId: input.suiteRunId,
    steps: input.steps,
    degradationLimit,
  });
  const sortedRisks = [...collected.risks].sort(compareReviewBriefRisks);
  const topRisks = sortedRisks.slice(0, riskLimit);
  const newFindings = sortedRisks.filter((risk) => risk.isNew).slice(0, riskLimit);
  const verdict = deriveReviewBriefVerdict({
    risks: sortedRisks,
    degraded: collected.degraded,
  });

  return {
    version: REVIEW_BRIEF_VERSION,
    suite: input.suite,
    suiteRunId: input.suiteRunId,
    verdict,
    changedFiles: input.changedFiles ?? null,
    topRisks,
    newFindings,
    baselineDelta: baselineDelta(sortedRisks, collected.baselineStates),
    degraded: collected.degraded,
    recommendedActions: recommendedActions({
      verdict,
      degraded: collected.degraded,
      risks: sortedRisks,
    }),
  };
}
