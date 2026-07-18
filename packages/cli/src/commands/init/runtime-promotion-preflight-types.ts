import type {
  RuntimePromotionConflictPolicy,
  RuntimePromotionRoute,
  RuntimePromotionSource,
} from './runtime-promotion-journal-schema.js';
import type {
  RuntimePromotionPathSnapshot,
  RuntimePromotionPreflightFsDependencies,
  RuntimePromotionSourceRevalidation,
} from './runtime-promotion-preflight-fs.js';
import type {
  RuntimePromotionPreliminaryManifestProof,
  RuntimePromotionRawManifestDependencies,
  RuntimePromotionRawManifestIdentity,
} from './runtime-promotion-preflight-manifest.js';
import type {
  RuntimePromotionPreflightConflictReason,
  RuntimePromotionPreliminaryEquality,
} from './runtime-promotion-preflight-policy.js';
import type { RuntimeExclusiveLease } from '@opensip-cli/core';

export interface RuntimePromotionPreflightInput {
  readonly projectRoot: string;
  readonly lease: RuntimeExclusiveLease;
  readonly conflict?: RuntimePromotionConflictPolicy;
}

export interface RuntimePromotionPreflightSelected {
  readonly status: 'selected';
  readonly route: RuntimePromotionRoute;
  readonly effectiveConflict: RuntimePromotionConflictPolicy;
  readonly source: RuntimePromotionSource;
  readonly destinationParentPreexisting: boolean;
  readonly destinationRuntimePreexisting: boolean;
  /** Internal canonical paths; never copy these into customer output or the journal. */
  readonly sourceRuntimeDir?: string;
  readonly destinationParentDir: string;
  readonly destinationRuntimeDir: string;
  readonly preliminaryEquality: RuntimePromotionPreliminaryEquality;
  readonly revalidation: RuntimePromotionPreflightRevalidationToken;
}

export interface RuntimePromotionPreflightConflict {
  readonly status: 'conflict';
  readonly reason: RuntimePromotionPreflightConflictReason;
  readonly effectiveConflict: RuntimePromotionConflictPolicy;
  readonly sourcePreserved: boolean;
  readonly allowedPolicies: readonly RuntimePromotionConflictPolicy[];
}

export type RuntimePromotionPreflightResult =
  RuntimePromotionPreflightSelected | RuntimePromotionPreflightConflict;

export type RuntimePromotionPreflightCheckpoint =
  | 'after-filesystem-inspection'
  | 'after-source-manifest'
  | 'after-destination-manifest'
  | 'before-return';

export interface RuntimePromotionPreflightDependencies
  extends RuntimePromotionPreflightFsDependencies, RuntimePromotionRawManifestDependencies {
  readonly checkpoint?: (checkpoint: RuntimePromotionPreflightCheckpoint) => void;
}

export interface RuntimePromotionPreflightRevalidationToken {
  readonly version: 1;
  readonly projectRoot: string;
  readonly coordinationKey: string;
  readonly cacheKey: string;
  readonly identityStrength: 'generation-bound' | 'path-only';
  readonly canonicalRootDigest: string;
  readonly generationDigest?: string;
  readonly projectRootSnapshot: RuntimePromotionPathSnapshot;
  readonly activeCandidateDir: string;
  readonly activeCandidate: RuntimePromotionPathSnapshot;
  readonly legacyCandidateDir?: string;
  readonly legacyCandidate?: RuntimePromotionPathSnapshot;
  readonly destinationParentDir: string;
  readonly destinationRuntimeDir: string;
  readonly destinationParent: RuntimePromotionPathSnapshot;
  readonly destinationRuntime: RuntimePromotionPathSnapshot;
  readonly source?: RuntimePromotionSourceRevalidation;
  readonly preliminary?: RuntimePromotionPreliminaryManifestProof;
}

export interface RuntimePromotionSourceRetirementProof {
  readonly version: 1;
  readonly projectRoot: string;
  readonly coordinationKey: string;
  readonly cacheKey: string;
  readonly identityStrength: 'generation-bound' | 'path-only';
  readonly canonicalRootDigest: string;
  readonly generationDigest?: string;
  readonly activeCandidateDir: string;
  readonly activeCandidate: RuntimePromotionPathSnapshot;
  readonly legacyCandidateDir?: string;
  readonly legacyCandidate?: RuntimePromotionPathSnapshot;
  readonly source: RuntimePromotionSourceRevalidation;
  readonly manifest: RuntimePromotionRawManifestIdentity;
}

export interface RuntimePromotionRevalidationDependencies
  extends RuntimePromotionPreflightFsDependencies, RuntimePromotionRawManifestDependencies {}
