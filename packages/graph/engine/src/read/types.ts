/**
 * Public graph/read error and identity types (ADR-0147).
 */

/** Closed operation set for graph read failures. */
export type GraphReadOperation = 'catalog-identity' | 'catalog-generation' | 'rebuild' | 'analysis';

/**
 * Bounded graph-package boundary error. Fixed message ≤160 chars; never carries
 * caught message/cause, stack, SQLite path, or source content.
 */
export interface GraphReadError {
  readonly code: string;
  readonly operation: GraphReadOperation;
  readonly message: string;
}

/** Lifted catalog identity columns (no payload). */
export interface CatalogIdentity {
  readonly language: string;
  readonly cacheKey: string;
  readonly filesFingerprint: string;
  readonly builtAt: string;
}

export type { CatalogVerdict, ValidationContext } from '../cache/invalidate.js';

export type { Catalog, Indexes, FeatureColumn } from '../types.js';
export type { GraphConfig } from '../types.js';
export type { RunGraphInput, RunGraphResult } from '../cli/orchestrate.js';
