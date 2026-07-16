/**
 * Graph impact command result (ADR-0085, spec §5.3).
 */
import type { GraphResolutionMode } from '../graph-catalog.js';
import type { ImpactFunction, ImpactPackage } from '../graph-impact-compute.js';
import type { ImpactTrust } from '../impact-trust.js';
import type { ChangedFileBasis } from '@opensip-cli/core';

export type GraphImpactBasis =
  ChangedFileBasis | { readonly type: 'files'; readonly files: readonly string[] };

/**
 * Bounded identity of the graph catalog used for an impact computation.
 *
 * The opaque adapter cache key and the file-stat fingerprint can contain local
 * absolute paths. Impact results therefore expose only their fixed-length
 * SHA-256 digests. The historical `filesFingerprint` name is retained because
 * it is the stable catalog-identity facet consumed by report readers.
 */
export interface GraphImpactCatalogIdentity {
  readonly builtAt: string;
  readonly language: string;
  readonly filesFingerprint: string;
  readonly resolutionMode?: GraphResolutionMode;
  readonly cacheKeyDigest: string;
}

export interface GraphImpactResult {
  readonly type: 'graph-impact';
  /**
   * Absent on legacy results and when the loaded catalog lacks a safely
   * representable cache key or files fingerprint.
   */
  readonly catalog?: GraphImpactCatalogIdentity;
  readonly basis: GraphImpactBasis;
  readonly changedFiles: readonly string[];
  readonly changedFunctions: readonly ImpactFunction[];
  readonly impactedFunctions: readonly ImpactFunction[];
  readonly impactedPackages: readonly ImpactPackage[];
  readonly impactedFiles: readonly string[];
  readonly trust: ImpactTrust;
  readonly recommendedCommands: readonly string[];
  readonly truncated: boolean;
}
