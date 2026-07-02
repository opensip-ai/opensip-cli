import {
  buildReviewBriefBaselineDelta,
  buildReviewBriefRecommendedActions,
  type CommandResult,
  compareReviewBriefRisks,
  deriveReviewBriefVerdict,
  pushReviewBriefDegradation,
  REVIEW_BRIEF_VERSION,
  reviewBriefBaselineState,
  signalToReviewBriefRisk,
  type ReviewBrief,
  type ReviewBriefBaselineState,
  type ReviewBriefDegradation,
  type ReviewBriefRisk,
  type StoredSession,
  type ToolSessionReplay,
} from '@opensip-cli/contracts';

import type { McpEvidenceDegradation } from './result-dto.js';

const DEFAULT_REVIEW_BRIEF_RISK_LIMIT = 20;
const DEFAULT_REVIEW_BRIEF_DEGRADATION_LIMIT = 20;

export interface PersistedReviewStep {
  readonly session: StoredSession;
  readonly replay?: ToolSessionReplay<CommandResult>;
  readonly error?: string;
  readonly errorCode?: McpEvidenceDegradation['code'];
}

export interface BuildPersistedReviewBriefInput {
  readonly suiteRunId: string;
  readonly suiteName?: string;
  readonly steps: readonly PersistedReviewStep[];
  readonly files?: readonly string[];
  readonly limit?: number;
}

export interface PersistedReviewBriefResult {
  readonly reviewBrief: ReviewBrief;
  readonly degradedSteps: number;
  readonly degraded?: readonly McpEvidenceDegradation[];
}

export function buildPersistedReviewBrief(
  input: BuildPersistedReviewBriefInput,
): PersistedReviewBriefResult {
  const riskLimit = input.limit ?? DEFAULT_REVIEW_BRIEF_RISK_LIMIT;
  const degradationLimit = DEFAULT_REVIEW_BRIEF_DEGRADATION_LIMIT;
  const orderedSteps = orderSteps(input.steps);
  const collected = collectRisks({
    suiteRunId: input.suiteRunId,
    steps: orderedSteps,
    degradationLimit,
  });
  const sortedRisks = [...collected.risks].sort(compareReviewBriefRisks);
  const focusedRisks = focusRisks(sortedRisks, input.files);
  const unavailableBaseline = collected.baselineStates.length === 0 && sortedRisks.length > 0;
  const degraded = [...collected.reviewDegraded];
  if (unavailableBaseline) {
    pushReviewBriefDegradation(
      degraded,
      {
        source: 'baseline',
        reason: 'No replayed signal carried baseline state metadata.',
        code: 'baseline-delta-unavailable',
      },
      degradationLimit,
    );
  }
  const verdict = deriveReviewBriefVerdict({
    risks: sortedRisks,
    degraded,
  });
  const reviewBrief: ReviewBrief = {
    version: REVIEW_BRIEF_VERSION,
    suite: input.suiteName ?? input.suiteRunId,
    suiteRunId: input.suiteRunId,
    verdict,
    changedFiles: input.files?.length ?? null,
    topRisks: focusedRisks.slice(0, riskLimit),
    newFindings: focusedRisks.filter((risk) => risk.isNew).slice(0, riskLimit),
    baselineDelta: buildReviewBriefBaselineDelta(sortedRisks, collected.baselineStates),
    degraded,
    recommendedActions: buildReviewBriefRecommendedActions({
      verdict,
      degraded,
      risks: sortedRisks,
    }),
  };
  const mcpDegraded = [...collected.evidenceDegraded];
  if (unavailableBaseline) {
    mcpDegraded.push({
      code: 'missing-baseline',
      message: 'No replayed signal carried baseline state metadata.',
    });
  }
  return {
    reviewBrief,
    degradedSteps: collected.degradedSteps,
    ...(mcpDegraded.length === 0 ? {} : { degraded: mcpDegraded }),
  };
}

function orderSteps(steps: readonly PersistedReviewStep[]): readonly PersistedReviewStep[] {
  return [...steps].sort((left, right) => {
    const started = compareCodePoint(left.session.startedAt, right.session.startedAt);
    return started === 0 ? compareCodePoint(left.session.id, right.session.id) : started;
  });
}

function focusRisks(
  risks: readonly ReviewBriefRisk[],
  files: readonly string[] | undefined,
): readonly ReviewBriefRisk[] {
  if (files === undefined || files.length === 0) return risks;
  const wanted = new Set(files);
  return risks.filter((risk) => wanted.has(risk.file));
}

function collectRisks(input: {
  readonly suiteRunId: string;
  readonly steps: readonly PersistedReviewStep[];
  readonly degradationLimit: number;
}): {
  readonly risks: readonly ReviewBriefRisk[];
  readonly reviewDegraded: readonly ReviewBriefDegradation[];
  readonly evidenceDegraded: readonly McpEvidenceDegradation[];
  readonly baselineStates: readonly ReviewBriefBaselineState[];
  readonly degradedSteps: number;
} {
  const risks: ReviewBriefRisk[] = [];
  const reviewDegraded: ReviewBriefDegradation[] = [];
  const evidenceDegraded: McpEvidenceDegradation[] = [];
  const baselineStates: ReviewBriefBaselineState[] = [];
  let degradedSteps = 0;

  input.steps.forEach((step, stepIndex) => {
    if (step.error !== undefined) {
      degradedSteps += 1;
      pushReviewBriefDegradation(
        reviewDegraded,
        {
          source: step.session.tool,
          reason: step.error,
          code: 'step-fault',
          stepIndex,
        },
        input.degradationLimit,
      );
      evidenceDegraded.push({
        code: step.errorCode ?? 'decode-error',
        message: step.error,
      });
      return;
    }

    const envelope = step.replay?.envelope;
    if (envelope === undefined) {
      degradedSteps += 1;
      const reason = `Stored suite step session '${step.session.id}' did not replay a SignalEnvelope.`;
      pushReviewBriefDegradation(
        reviewDegraded,
        {
          source: step.session.tool,
          reason,
          code: 'missing-envelope',
          stepIndex,
        },
        input.degradationLimit,
      );
      evidenceDegraded.push({ code: 'missing-suite-evidence', message: reason });
      return;
    }

    if (!envelope.verdict.passed && envelope.signals.length === 0) {
      pushReviewBriefDegradation(
        reviewDegraded,
        {
          source: envelope.tool,
          reason: `Stored suite step session '${step.session.id}' replayed a failing verdict without signals.`,
          code: 'failing-verdict-without-signals',
          stepIndex,
        },
        input.degradationLimit,
      );
    }

    const missingFingerprints = envelope.signals.filter((signal) => !signal.fingerprint).length;
    if (missingFingerprints > 0) {
      pushReviewBriefDegradation(
        reviewDegraded,
        {
          source: envelope.tool,
          reason: `${String(missingFingerprints)} signal(s) were missing baseline fingerprints.`,
          code: 'missing-fingerprint',
          stepIndex,
        },
        input.degradationLimit,
      );
      evidenceDegraded.push({
        code: 'missing-fingerprint',
        message: `${String(missingFingerprints)} signal(s) were missing baseline fingerprints.`,
        count: missingFingerprints,
      });
    }

    envelope.signals.forEach((signal, signalIndex) => {
      const state = reviewBriefBaselineState(signal);
      if (state !== undefined) baselineStates.push(state);
      risks.push(
        signalToReviewBriefRisk({
          suiteRunId: input.suiteRunId,
          stepIndex,
          signalIndex,
          signal,
          tool: envelope.tool,
          runId: envelope.runId,
        }),
      );
    });
  });

  return { risks, reviewDegraded, evidenceDegraded, baselineStates, degradedSteps };
}

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
