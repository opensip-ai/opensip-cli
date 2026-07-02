import { isErrorSeverity } from '@opensip-cli/core';
import { z } from 'zod';

import type { SignalRepair, SignalSeverity } from '@opensip-cli/core';

export const REVIEW_BRIEF_VERSION = 1;

export type ReviewBriefVersion = typeof REVIEW_BRIEF_VERSION;
export type ReviewBriefVerdict = 'pass' | 'warn' | 'fail';

export interface ReviewBriefSignalRef {
  readonly tool: string;
  readonly suiteRunId: string;
  readonly stepIndex: number;
  readonly runId?: string;
  readonly fingerprint?: string;
  readonly signalIndex: number;
}

export interface ReviewBriefBlastRadius {
  readonly dependents: number;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly impactedFiles?: number;
}

export interface ReviewBriefRisk {
  readonly source: string;
  readonly ruleId: string;
  readonly message: string;
  readonly severity: SignalSeverity;
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly isNew: boolean;
  readonly signalRef: ReviewBriefSignalRef;
  readonly repair?: SignalRepair;
  readonly blastRadius?: ReviewBriefBlastRadius;
  readonly dedupedRefs?: readonly ReviewBriefSignalRef[];
}

export interface ReviewBriefBaselineDelta {
  readonly available: boolean;
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
}

export interface ReviewBriefDegradation {
  readonly source: string;
  readonly reason: string;
  readonly code?:
    | 'missing-envelope'
    | 'step-fault'
    | 'missing-fingerprint'
    | 'failing-verdict-without-signals'
    | 'baseline-delta-unavailable';
  readonly stepIndex?: number;
}

export interface ReviewBriefRecommendedAction {
  readonly priority: 'high' | 'medium' | 'low';
  readonly message: string;
  readonly source?: string;
  readonly command?: string;
}

export interface ReviewBrief {
  readonly version: ReviewBriefVersion;
  readonly suite: string;
  readonly suiteRunId: string;
  readonly verdict: ReviewBriefVerdict;
  /** `null` means the suite run did not have trustworthy changed-file cardinality. */
  readonly changedFiles: number | null;
  readonly topRisks: readonly ReviewBriefRisk[];
  readonly newFindings: readonly ReviewBriefRisk[];
  readonly baselineDelta: ReviewBriefBaselineDelta;
  readonly degraded: readonly ReviewBriefDegradation[];
  readonly recommendedActions: readonly ReviewBriefRecommendedAction[];
}

export interface DeriveReviewBriefVerdictInput {
  readonly risks?: readonly Pick<ReviewBriefRisk, 'severity'>[];
  readonly degraded?: readonly unknown[];
}

const severityRank: Readonly<Record<SignalSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

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

export const reviewBriefSignalRefSchema = z
  .object({
    tool: z.string(),
    suiteRunId: z.string(),
    stepIndex: z.number().int().nonnegative(),
    runId: z.string().optional(),
    fingerprint: z.string().optional(),
    signalIndex: z.number().int().nonnegative(),
  })
  .strict();

export const reviewBriefRepairSchema = z
  .object({
    repairKind: z
      .enum(['add-test', 'split-function', 'extract-module', 'fix-import', 'manual', 'unknown'])
      .optional(),
    autofixable: z.boolean().optional(),
    suggestedCommand: z.string().optional(),
    docsRef: z.string().optional(),
    confidence: z.number().optional(),
    patchHint: z
      .object({
        kind: z.enum(['text', 'structured']),
        summary: z.string(),
        target: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const reviewBriefBlastRadiusSchema = z
  .object({
    dependents: z.number().int().nonnegative(),
    confidence: z.enum(['low', 'medium', 'high']),
    impactedFiles: z.number().int().nonnegative().optional(),
  })
  .strict();

export const reviewBriefRiskSchema = z
  .object({
    source: z.string(),
    ruleId: z.string(),
    message: z.string(),
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    file: z.string(),
    line: z.number().int().positive().optional(),
    column: z.number().int().nonnegative().optional(),
    isNew: z.boolean(),
    signalRef: reviewBriefSignalRefSchema,
    repair: reviewBriefRepairSchema.optional(),
    blastRadius: reviewBriefBlastRadiusSchema.optional(),
    dedupedRefs: z.array(reviewBriefSignalRefSchema).optional(),
  })
  .strict();

export const reviewBriefBaselineDeltaSchema = z
  .object({
    available: z.boolean(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  })
  .strict();

export const reviewBriefDegradationSchema = z
  .object({
    source: z.string(),
    reason: z.string(),
    code: z
      .enum([
        'missing-envelope',
        'step-fault',
        'missing-fingerprint',
        'failing-verdict-without-signals',
        'baseline-delta-unavailable',
      ])
      .optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

export const reviewBriefRecommendedActionSchema = z
  .object({
    priority: z.enum(['high', 'medium', 'low']),
    message: z.string(),
    source: z.string().optional(),
    command: z.string().optional(),
  })
  .strict();

export const reviewBriefSchema = z
  .object({
    version: z.literal(REVIEW_BRIEF_VERSION),
    suite: z.string(),
    suiteRunId: z.string(),
    verdict: z.enum(['pass', 'warn', 'fail']),
    changedFiles: z.number().int().nonnegative().nullable(),
    topRisks: z.array(reviewBriefRiskSchema),
    newFindings: z.array(reviewBriefRiskSchema),
    baselineDelta: reviewBriefBaselineDeltaSchema,
    degraded: z.array(reviewBriefDegradationSchema),
    recommendedActions: z.array(reviewBriefRecommendedActionSchema),
  })
  .strict();
