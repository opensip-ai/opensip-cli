import type { SignalSeverity } from '@opensip-cli/core';

/** Maximum correlated groups emitted on a review brief. */
export const REVIEW_BRIEF_CORRELATION_GROUP_LIMIT = 20;
/** Maximum members retained per correlated group. */
export const REVIEW_BRIEF_CORRELATION_MEMBER_LIMIT = 10;
/** Maximum entity refs retained per risk or group. */
export const REVIEW_BRIEF_CORRELATION_ENTITY_LIMIT = 12;
/** Maximum correlation keys retained per risk. */
export const REVIEW_BRIEF_CORRELATION_KEY_LIMIT = 12;
/** Maximum reasons retained per group. */
export const REVIEW_BRIEF_CORRELATION_REASON_LIMIT = 5;

/** Confidence level for review-brief correlation evidence. */
export type ReviewBriefCorrelationConfidence = 'low' | 'medium' | 'high';

/** Entity kinds used by the review-brief correlation join. */
export type ReviewBriefEntityKind =
  'fingerprint' | 'file' | 'file-range' | 'symbol' | 'graph-node' | 'package';

/** Stable entity reference projected from a signal for correlation. */
export interface ReviewBriefEntityRef {
  readonly kind: ReviewBriefEntityKind;
  readonly id: string;
  readonly confidence: ReviewBriefCorrelationConfidence;
  readonly label?: string;
  readonly file?: string;
  readonly line?: number;
  readonly source?: string;
}

/** Correlation key kinds, ordered by grouping strength. */
export type ReviewBriefCorrelationKeyKind =
  'fingerprint' | 'graph-node' | 'symbol' | 'rule-location' | 'file-range' | 'package' | 'file';

/** A deterministic key that can place a risk into a correlation group. */
export interface ReviewBriefCorrelationKey {
  readonly kind: ReviewBriefCorrelationKeyKind;
  readonly value: string;
  readonly confidence: ReviewBriefCorrelationConfidence;
}

/** Explainable reason for a correlated group. */
export interface ReviewBriefCorrelationReason {
  readonly kind:
    | 'same-fingerprint'
    | 'same-graph-node'
    | 'same-symbol'
    | 'same-rule-location'
    | 'same-file-range'
    | 'same-package'
    | 'same-file';
  readonly key: ReviewBriefCorrelationKey;
  readonly confidence: ReviewBriefCorrelationConfidence;
  readonly message: string;
}

/** Signal provenance shape retained inside correlation groups. */
export interface ReviewBriefCorrelationSignalRef {
  readonly tool: string;
  readonly suiteRunId: string;
  readonly stepIndex: number;
  readonly runId?: string;
  readonly fingerprint?: string;
  readonly signalIndex: number;
}

/** Bounded blast-radius shape retained inside correlation groups. */
export interface ReviewBriefCorrelationBlastRadius {
  readonly dependents: number;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly impactedFiles?: number;
}

/** Bounded risk shape accepted by the correlation builder. */
export interface ReviewBriefCorrelationRisk {
  readonly source: string;
  readonly ruleId: string;
  readonly severity: SignalSeverity;
  readonly file: string;
  readonly line?: number;
  readonly column?: number;
  readonly isNew: boolean;
  readonly signalRef: ReviewBriefCorrelationSignalRef;
  readonly blastRadius?: ReviewBriefCorrelationBlastRadius;
  readonly entities?: readonly ReviewBriefEntityRef[];
  readonly correlationKeys?: readonly ReviewBriefCorrelationKey[];
}

/** Bounded reference to a raw review-brief risk inside a correlation group. */
export interface ReviewBriefRiskRef {
  readonly source: string;
  readonly ruleId: string;
  readonly file: string;
  readonly signalRef: ReviewBriefCorrelationSignalRef;
  readonly line?: number;
  readonly column?: number;
}

/** One non-destructive group of related review risks. */
export interface ReviewBriefCorrelationGroup {
  readonly id: string;
  readonly title: string;
  readonly severity: SignalSeverity;
  readonly isNew: boolean;
  readonly primary: ReviewBriefRiskRef;
  readonly members: readonly ReviewBriefRiskRef[];
  readonly entities: readonly ReviewBriefEntityRef[];
  readonly reasons: readonly ReviewBriefCorrelationReason[];
  readonly blastRadius?: ReviewBriefCorrelationBlastRadius;
}

/** Options for building review-brief correlation groups. */
export interface BuildReviewBriefCorrelationsOptions {
  readonly groupLimit?: number;
  readonly memberLimit?: number;
  readonly entityLimit?: number;
  readonly reasonLimit?: number;
}

export const REVIEW_BRIEF_CORRELATION_KEY_PRIORITY: Readonly<
  Record<ReviewBriefCorrelationKeyKind, number>
> = {
  fingerprint: 0,
  'graph-node': 1,
  symbol: 2,
  'rule-location': 3,
  'file-range': 4,
  package: 5,
  file: 6,
};

export const REVIEW_BRIEF_SEVERITY_RANK: Readonly<Record<SignalSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
