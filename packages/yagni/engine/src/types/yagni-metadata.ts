/**
 * Canonical `metadata.yagni` shape stamped on every YAGNI finding signal (spec §7).
 */

export type YagniConfidence = 'low' | 'medium' | 'high';

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

export type YagniEstimateKind = 'exact' | 'lower-bound' | 'heuristic';

export interface YagniLocDelta {
  readonly remove: number;
  readonly add: number;
  readonly netEstimate: number;
  readonly estimateKind: YagniEstimateKind;
}

export interface YagniEvidence {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface YagniFindingMetadata {
  readonly detector: string;
  readonly reductionCategory: YagniReductionCategory;
  readonly confidence: YagniConfidence;
  readonly locDelta?: YagniLocDelta;
  readonly preservationArgument: string;
  readonly suggestedAction: string;
  readonly validationRequired: readonly string[];
  readonly riskTags: readonly string[];
  readonly evidence: readonly YagniEvidence[];
}

export interface YagniRunSummary {
  readonly totalCandidates: number;
  readonly byConfidence: {
    readonly high: number;
    readonly medium: number;
    readonly low: number;
  };
  readonly estimatedTotalLocReduction: number;
  readonly graphMode: string;
  readonly skippedDetectors: readonly {
    readonly slug: string;
    readonly reason: string;
    readonly detail?: string;
  }[];
}
