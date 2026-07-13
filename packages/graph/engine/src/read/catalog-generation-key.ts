/** Canonical opaque identity for one immutable persisted graph generation. */

import { createHash } from 'node:crypto';

import type { CatalogIdentity } from './types.js';

/**
 * Hash the fixed lifted catalog identity tuple.
 *
 * The namespace and tuple order intentionally preserve the original MCP-owned
 * algorithm byte-for-byte. Keeping the function at the graph/read boundary
 * lets graph producers and MCP replay name exactly the same `g1:` generation
 * without creating a graph -> MCP dependency.
 */
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
