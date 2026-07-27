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
 * Closed reason set for graph read failures (Plan 01 ruling `result-reason-code-scope`).
 *
 * These are `Result` reasons, NOT registered error codes, and the spelling says so. They used
 * to be written `GRAPH.READ.CATALOG_GENERATION` — indistinguishable from `GRAPH.CATALOG.UNREADABLE`,
 * which IS registered and carries `severity`, `retry`, `exitClass` and an `operatorAction`. A
 * consumer could not tell which contract it held. Kebab matches `GraphReadOperation` directly
 * below, and matches the vocabulary MCP already publishes on its wire.
 *
 * The type is closed rather than `string` because that was the actual defect the ruling names:
 * an untyped reason field lets two producers drift apart with nothing to catch it.
 *
 * Where a reason corresponds 1:1 to a registered definition, the DEFINITION points back at it
 * through `publicPresentationKey` — see `errors/graph-error-catalog.ts`. The link is declared
 * once, on the side that has axes to declare.
 */
export type GraphReadReason =
  | 'catalog-identity'
  | 'catalog-generation'
  | 'catalog-unreadable'
  | 'context-snapshot'
  | 'cursor-invalid'
  | 'entity-failed'
  | 'entity-id-invalid'
  | 'entity-malformed'
  | 'impact-cancelled'
  | 'impact-failed'
  | 'impact-file-invalid'
  | 'impact-files-cap'
  | 'impact-index-generation-mismatch'
  | 'query-invalid'
  | 'rebuild-cancelled'
  | 'rebuild-configuration'
  | 'rebuild-empty'
  | 'rebuild-failed'
  | 'test-selection-cancelled'
  | 'test-selection-failed'
  | 'test-selection-file-invalid'
  | 'test-selection-files-cap'
  | 'test-selection-graph-identity-invalid'
  | 'verify-cache-key'
  | 'verify-descriptor'
  | 'verify-discovery'
  | 'verify-registry'
  | 'verify-selection'
  | 'context-catalog-datastore-required'
  | 'context-catalog-identity-failed'
  | 'context-catalog-load-failed'
  | 'context-catalog-replace-failed';

/**
 * Bounded graph-package boundary error. Fixed message ≤160 chars; never carries
 * caught message/cause, stack, SQLite path, or source content.
 */
export interface GraphReadError {
  readonly code: GraphReadReason;
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

export type { Catalog, Indexes, FeatureColumn, FeatureTable } from '../types.js';
export type { GraphConfig } from '../types.js';
