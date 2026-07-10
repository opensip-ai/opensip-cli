/**
 * Public graph/read error and identity types (ADR-0147).
 */

import type { GraphLanguageAdapter } from '../lang-adapter/types.js';
import type { DataStore } from '@opensip-cli/datastore';

/** Narrow graph-adapter registry reader used by public read operations. */
export interface GraphAdapterRegistryReader {
  readonly size: number;
  getAll(): readonly { readonly id: string; readonly adapter: GraphLanguageAdapter }[];
  getById(id: string): { readonly adapter: GraphLanguageAdapter } | undefined;
}

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

/**
 * Minimal host input for rebuilding the persisted catalog through the public
 * read boundary. Pipeline controls, rules, and progress callbacks remain
 * orchestration-internal.
 */
export interface RebuildCatalogInput {
  readonly cwd: string;
  readonly datastore?: DataStore;
}

export type { CatalogVerdict, ValidationContext } from '../cache/invalidate.js';

export type { Catalog, Indexes, FeatureColumn } from '../types.js';
export type { GraphConfig } from '../types.js';
