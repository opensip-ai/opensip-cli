import type { GraphCatalog, GraphFunctionOccurrence } from './graph-catalog.js';
import type { ImpactTrust, ImpactUncertainty } from './impact-trust.js';

export interface ImpactFunction {
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
  readonly package?: string;
  readonly blastScore?: number;
  readonly testReachable?: boolean;
  readonly reason: 'changed' | 'caller' | 'callee' | 'blast' | 'test-gap' | 'coupling';
}

export interface ImpactPackage {
  readonly name: string;
  readonly functionCount: number;
}

export interface ImpactComputation {
  readonly changedFunctions: readonly ImpactFunction[];
  readonly impactedFunctions: readonly ImpactFunction[];
  readonly impactedPackages: readonly ImpactPackage[];
  readonly impactedFiles: readonly string[];
  readonly trust: ImpactTrust;
  readonly truncated: boolean;
}

export interface ComputeImpactChangedFileEntry {
  readonly path: string;
  readonly status?:
    'added' | 'modified' | 'copied' | 'renamed' | 'deleted' | 'untracked' | 'unknown';
  readonly previousPath?: string;
}

export interface ComputeImpactOptions {
  readonly maxDepth?: number;
  readonly top?: number;
  readonly changedFileEntries?: readonly ComputeImpactChangedFileEntry[];
  readonly uncertainties?: readonly ImpactUncertainty[];
}

export interface ComputeImpactAsyncOptions extends ComputeImpactOptions {
  readonly index?: ComputeImpactIndex;
  readonly signal?: AbortSignal;
}

export interface ComputeImpactIndex {
  readonly sourceCatalog: GraphCatalog;
  readonly catalogGenerationIdentity: string;
  readonly occurrences: readonly GraphFunctionOccurrence[];
  readonly occurrencesByFile: ReadonlyMap<string, readonly GraphFunctionOccurrence[]>;
  readonly occurrenceOrdinal: ReadonlyMap<GraphFunctionOccurrence, number>;
  readonly reverseAdjacency: ReadonlyMap<string, readonly number[]>;
  readonly catalogFiles: ReadonlySet<string>;
  readonly catalogApproximate: boolean;
}

export class ComputeImpactIndexGenerationMismatchError extends Error {
  constructor() {
    super('ComputeImpactIndex belongs to a different graph catalog generation.');
    this.name = 'ComputeImpactIndexGenerationMismatchError';
  }
}

export class ComputeImpactCancelledError extends Error {
  constructor() {
    super('Impact computation was cancelled.');
    this.name = 'ComputeImpactCancelledError';
  }
}
