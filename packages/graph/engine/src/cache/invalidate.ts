/**
 * Cache invalidation (skeleton; implemented in P6).
 *
 * Content-keyed invalidation by tsCompilerVersion + tsConfigPath
 * content hash + per-file bodyHash agreement.
 */

import type { Catalog } from '../types.js';

export function isCatalogValid(_cached: Catalog, _currentTsConfigPath: string): boolean {
  return false;
}
