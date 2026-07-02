import {
  buildReviewBriefBaselineDelta,
  buildReviewBriefRecommendedActions,
  REVIEW_BRIEF_VERSION,
  compareReviewBriefRisks,
  deriveReviewBriefVerdict,
  pushReviewBriefDegradation,
  reviewBriefBaselineState,
  signalToReviewBriefRisk,
  type ReviewBrief,
  type ReviewBriefBaselineState,
  type ReviewBriefDegradation,
  type ReviewBriefRisk,
} from '@opensip-cli/contracts';

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

function collectRisks(input: {
  readonly suiteRunId: string;
  readonly steps: readonly SuiteStepReviewInput[];
  readonly degradationLimit: number;
}): {
  readonly risks: readonly ReviewBriefRisk[];
  readonly degraded: readonly ReviewBriefDegradation[];
  readonly baselineStates: readonly ReviewBriefBaselineState[];
} {
  const risks: ReviewBriefRisk[] = [];
  const degraded: ReviewBriefDegradation[] = [];
  const baselineStates: ReviewBriefBaselineState[] = [];

  for (const step of input.steps) {
    if (step.summary.error !== undefined) {
      pushReviewBriefDegradation(
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
      pushReviewBriefDegradation(
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
      pushReviewBriefDegradation(
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
      pushReviewBriefDegradation(
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
      const state = reviewBriefBaselineState(signal);
      if (state !== undefined) baselineStates.push(state);
      risks.push(
        signalToReviewBriefRisk({
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
    baselineDelta: buildReviewBriefBaselineDelta(sortedRisks, collected.baselineStates),
    degraded: collected.degraded,
    recommendedActions: buildReviewBriefRecommendedActions({
      verdict,
      degraded: collected.degraded,
      risks: sortedRisks,
    }),
  };
}
