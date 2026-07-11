/** Immutable catalog generation identity and derived-index construction. */

import { createHash } from 'node:crypto';

import {
  buildGraphReadIndexes,
  type Catalog,
  type CatalogIdentity,
  type FeatureTable,
  type Indexes,
} from '@opensip-cli/graph/read';


export type GenerationSource = 'initial-load' | 'persisted-auto-swap' | 'refresh-rebuild';

/** Canonical opaque generation key over the fixed persisted identity tuple. */
export function catalogGenerationKey(identity: CatalogIdentity): string {
  const payload = JSON.stringify([
    'opensip:mcp:catalog-generation',
    1,
    identity.language,
    identity.cacheKey,
    identity.filesFingerprint,
    identity.builtAt,
  ]);
  return `g1:${createHash('sha256').update(payload, 'utf8').digest('hex')}`;
}

/** One immutable in-memory snapshot of the served catalog plus derived indexes. */
export interface CatalogGeneration {
  readonly key: string;
  readonly catalog: Catalog;
  readonly indexes: Indexes;
  readonly builtAt: string;
  readonly loadedAt: string;
  readonly source: GenerationSource;
  readonly derived: { features?: FeatureTable };
}

export function createGeneration(
  catalog: Catalog,
  source: GenerationSource,
  identity?: CatalogIdentity,
): CatalogGeneration {
  const generationIdentity: CatalogIdentity = identity ?? {
    language: catalog.language,
    cacheKey: catalog.cacheKey,
    filesFingerprint: catalog.filesFingerprint ?? '',
    builtAt: catalog.builtAt,
  };
  return {
    key: catalogGenerationKey(generationIdentity),
    catalog,
    indexes: buildGraphReadIndexes(catalog),
    builtAt: catalog.builtAt,
    loadedAt: new Date().toISOString(),
    source,
    derived: {},
  };
}

export interface RefreshOutcome {
  readonly action: 'no-op' | 'reloaded' | 'rebuilt';
  readonly generation: CatalogGeneration;
  readonly durationMs: number;
  readonly priorGenerationAvailable: boolean;
}
