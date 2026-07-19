import {
  REVIEW_BRIEF_VERSION,
  type ReviewBrief,
  type ReviewBriefBaselineState,
  type ReviewBriefDegradation,
  type ReviewBriefRisk,
} from '@opensip-cli/contracts';
import {
  buildReviewBriefBaselineDelta,
  buildReviewBriefCorrelations,
  buildReviewBriefRecommendedActions,
  compareReviewBriefRisks,
  deriveReviewBriefVerdict,
  pushReviewBriefDegradation,
  reviewBriefBaselineState,
  signalToReviewBriefRisk,
} from '@opensip-cli/shared-analysis';

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

function pushStepSummaryDegradations(
  degraded: ReviewBriefDegradation[],
  step: SuiteStepReviewInput,
  degradationLimit: number,
): void {
  if (step.summary.error !== undefined) {
    pushReviewBriefDegradation(
      degraded,
      {
        source: step.summary.tool,
        reason: step.summary.error,
        code: 'step-fault',
        stepIndex: step.stepIndex,
      },
      degradationLimit,
    );
  }

  if (step.summary.verification === undefined || step.summary.verification.fullyVerified) return;
  const uncertaintyCodes = step.summary.verification.uncertainties
    .map((item) => item.code)
    .join(', ');
  pushReviewBriefDegradation(
    degraded,
    {
      source: step.summary.tool,
      reason:
        `Step '${step.summary.command}' had ${step.summary.verification.coverage} impact verification` +
        (uncertaintyCodes ? ` (${uncertaintyCodes}).` : '.'),
      code: 'impact-verification-partial',
      stepIndex: step.stepIndex,
    },
    degradationLimit,
  );
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
    pushStepSummaryDegradations(degraded, step, input.degradationLimit);

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

    // A runtime FAULT (a unit threw/timed-out) must surface as a degradation so
    // the brief raises "result unverified", distinct from a findings failure. The
    // authoritative signal is `verdict.faulted`; the legacy `!passed && 0 signals`
    // clause is kept as a fallback for a pre-tri-state captured envelope (algebra:
    // 0 signals ⟹ policyPasses, so `!passed` there already means faulted). Keying
    // on `faulted` also catches a fault that emitted OTHER units' signals
    // (`signals.length > 0`) — invisible to the old zero-signal-only clause.
    const stepFaulted =
      envelope.verdict.faulted === true ||
      (!envelope.verdict.passed && envelope.signals.length === 0);
    if (stepFaulted) {
      const hasSignals = envelope.signals.length > 0;
      pushReviewBriefDegradation(
        degraded,
        {
          source: envelope.tool,
          reason: hasSignals
            ? `Step '${step.summary.command}' faulted at runtime; its findings may be incomplete.`
            : `Step '${step.summary.command}' reported a failing verdict without signals.`,
          // Reuse the established codes (no contract change): a fault alongside
          // findings is a `step-fault`; the signal-less case keeps its historical code.
          code: hasSignals ? 'step-fault' : 'failing-verdict-without-signals',
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
  const correlatedRisks = buildReviewBriefCorrelations(sortedRisks);
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
    ...(correlatedRisks.length === 0 ? {} : { correlatedRisks }),
  };
}
