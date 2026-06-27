/**
 * Graph impact command result (ADR-0085, spec §5.3).
 */
import type { ImpactFunction, ImpactPackage } from '../graph-impact-compute.js';
import type { ChangedFileBasis } from '@opensip-cli/core';

export type GraphImpactBasis =
  | ChangedFileBasis
  | { readonly type: 'files'; readonly files: readonly string[] };

export interface GraphImpactResult {
  readonly type: 'graph-impact';
  readonly basis: GraphImpactBasis;
  readonly changedFiles: readonly string[];
  readonly changedFunctions: readonly ImpactFunction[];
  readonly impactedFunctions: readonly ImpactFunction[];
  readonly impactedPackages: readonly ImpactPackage[];
  readonly recommendedCommands: readonly string[];
  readonly truncated: boolean;
}
