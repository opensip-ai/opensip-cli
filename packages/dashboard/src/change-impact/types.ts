import type {
  ReviewBrief,
  ReviewBriefVerdict,
  StoredRunAggregate,
  SuiteRunScope,
} from '@opensip-cli/contracts';

export type ChangeImpactAvailability =
  'available' | 'projection-degraded' | 'step-faulted' | 'missing-session' | 'legacy' | 'malformed';

export type ChangeImpactCatalogMatch =
  'matching' | 'mismatched' | 'missing-stored' | 'missing-current';

export interface ChangeImpactOmittedCounts {
  readonly changedFiles: number;
  readonly changedFunctions: number;
  readonly impactedFunctions: number;
  readonly impactedFiles: number;
  readonly impactedPackages: number;
  readonly recommendedCommands: number;
  readonly uncertainties: number;
  readonly risks: number;
  readonly newFindings: number;
  readonly correlations: number;
  readonly actions: number;
  readonly degradations: number;
}

export interface ChangeImpactCatalogIdentity {
  readonly builtAt: string;
  readonly language: string;
  readonly filesFingerprint: string;
  readonly resolutionMode?: 'exact' | 'fast';
  readonly cacheKeyDigest: string;
}

export interface ChangeImpactFunction {
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
  readonly package?: string;
  readonly reason: string;
  readonly bodyHash?: string;
  readonly navigation: 'available' | 'catalog-unavailable' | 'not-found' | 'ambiguous';
}

export interface ChangeImpactPackage {
  readonly name: string;
  readonly functionCount: number;
}

export interface ChangeImpactUncertainty {
  readonly code: string;
  readonly source: string;
  readonly message: string;
  readonly filePath?: string;
}

export interface ChangeImpactTrust {
  readonly coverage: 'full' | 'partial' | 'unknown';
  readonly fallback: string;
  readonly fullyVerified: boolean;
  readonly uncertainties: readonly ChangeImpactUncertainty[];
}

export interface ChangeImpactEvidence {
  readonly catalog?: ChangeImpactCatalogIdentity;
  readonly basisType: 'changed' | 'files';
  readonly basisRef?: string;
  readonly changedFiles: readonly string[];
  readonly changedFunctions: readonly ChangeImpactFunction[];
  readonly impactedFunctions: readonly ChangeImpactFunction[];
  readonly impactedFiles: readonly string[];
  readonly impactedPackages: readonly ChangeImpactPackage[];
  readonly trust: ChangeImpactTrust;
  readonly recommendedCommands: readonly string[];
  readonly truncated: boolean;
  readonly backendOmitted: Omit<
    ChangeImpactOmittedCounts,
    'uncertainties' | 'risks' | 'newFindings' | 'correlations' | 'actions' | 'degradations'
  >;
  readonly detailTruncated: boolean;
  readonly metadataOmitted: boolean;
}

export interface ChangeImpactViewModel {
  readonly runId: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly verdict: ReviewBriefVerdict;
  readonly aggregate: StoredRunAggregate;
  readonly scope?: SuiteRunScope;
  readonly reviewBrief?: ReviewBrief;
  readonly reviewBriefState: 'available' | 'missing' | 'malformed';
  readonly availability: ChangeImpactAvailability;
  readonly availabilityReason: string;
  readonly catalogMatch: ChangeImpactCatalogMatch;
  readonly zeroImpact: boolean;
  readonly sourceTruncated: boolean;
  readonly evidence?: ChangeImpactEvidence;
  readonly reportOmitted: ChangeImpactOmittedCounts;
}

export interface BoundedChangeImpactRuns {
  readonly runs: readonly ChangeImpactViewModel[];
  readonly omittedRuns: number;
}
