/**
 * Review-brief CONTRACT surface: the version constant, the ReviewBrief type
 * family, and the `reviewBrief*Schema` zod schemas that validate persisted
 * review-brief payloads on MCP replay. The executable derivation
 * (compareReviewBriefRisks, signalToReviewBriefRisk, verdict/action builders)
 * lives in @opensip-cli/shared-analysis (Plan 09 Phase 7) — this module stays
 * a frozen type/constant/schema facade.
 */
import { z } from 'zod';

import {
  reviewBriefCorrelationGroupSchema,
  reviewBriefCorrelationKeySchema,
  reviewBriefEntityRefSchema,
} from './review-brief-correlation-schemas.js';

import type {
  ReviewBriefCorrelationGroup,
  ReviewBriefCorrelationKey,
  ReviewBriefEntityRef,
} from './review-brief-correlation-types.js';
import type { Signal, SignalRepair, SignalSeverity } from '@opensip-cli/core';

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
  readonly entities?: readonly ReviewBriefEntityRef[];
  readonly correlationKeys?: readonly ReviewBriefCorrelationKey[];
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
    | 'impact-verification-partial'
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
  readonly correlatedRisks?: readonly ReviewBriefCorrelationGroup[];
}

export interface DeriveReviewBriefVerdictInput {
  readonly risks?: readonly Pick<ReviewBriefRisk, 'severity'>[];
  readonly degraded?: readonly unknown[];
}

export type ReviewBriefBaselineState = 'added' | 'unchanged';

export interface SignalToReviewBriefRiskInput {
  readonly suiteRunId: string;
  readonly stepIndex: number;
  readonly signalIndex: number;
  readonly signal: Signal;
  readonly tool: string;
  readonly runId: string;
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
    actions: z
      .array(
        z
          .object({
            id: z.string(),
            kind: z.string(),
            title: z.string(),
            description: z.string().optional(),
            autofixable: z.boolean(),
            confidence: z.number().optional(),
            patchHint: z
              .object({
                kind: z.enum(['text', 'structured']),
                summary: z.string(),
                target: z.string().optional(),
              })
              .strict()
              .optional(),
            verification: z
              .object({
                commands: z.array(z.string()),
                notes: z.array(z.string()).optional(),
              })
              .strict()
              .optional(),
            target: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
          })
          .strict(),
      )
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
    entities: z.array(reviewBriefEntityRefSchema).optional(),
    correlationKeys: z.array(reviewBriefCorrelationKeySchema).optional(),
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
        'impact-verification-partial',
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
    correlatedRisks: z.array(reviewBriefCorrelationGroupSchema).optional(),
  })
  .strict();
