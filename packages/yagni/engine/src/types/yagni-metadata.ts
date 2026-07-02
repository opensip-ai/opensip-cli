/**
 * Canonical `metadata.yagni` shape stamped on every YAGNI finding signal (spec §7).
 */

export type YagniConfidence = 'low' | 'medium' | 'high';

/** Reduction class used to group YAGNI findings by intended simplification. */
export type YagniReductionCategory =
  | 'delete'
  | 'collapse'
  | 'inline'
  | 'dedupe'
  | 'stdlib'
  | 'native'
  | 'dependency'
  | 'config'
  | 'shrink';

/** Confidence level for the LOC estimate attached to a finding. */
export type YagniEstimateKind = 'exact' | 'lower-bound' | 'heuristic';

/** Estimated line-count impact for applying a reduction candidate. */
export interface YagniLocDelta {
  readonly remove: number;
  readonly add: number;
  readonly netEstimate: number;
  readonly estimateKind: YagniEstimateKind;
}

/** Evidence item supporting a YAGNI reduction candidate. */
export interface YagniEvidence {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

/** Convention context that reduced confidence for a YAGNI candidate. */
export interface YagniConventionAdjustment {
  readonly kind: 'entrypoint' | 'alwaysUsed';
  readonly targetName: string;
  readonly pattern: string;
}

/** Metadata payload carried on each YAGNI signal. */
export interface YagniFindingMetadata {
  readonly detector: string;
  readonly reductionCategory: YagniReductionCategory;
  readonly confidence: YagniConfidence;
  readonly locDelta?: YagniLocDelta;
  readonly preservationArgument: string;
  readonly validationRequired: readonly string[];
  readonly riskTags: readonly string[];
  readonly evidence: readonly YagniEvidence[];
  readonly conventionAdjustment?: YagniConventionAdjustment;
}

/** Aggregate summary persisted with a YAGNI run session. */
export interface YagniRunSummary {
  readonly totalCandidates: number;
  readonly byConfidence: {
    readonly high: number;
    readonly medium: number;
    readonly low: number;
  };
  readonly estimatedTotalLocReduction: number;
  readonly skippedDetectors: readonly {
    readonly slug: string;
    readonly reason: string;
    readonly detail?: string;
  }[];
}
