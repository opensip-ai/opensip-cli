/**
 * catalog-fallback resolver — last-resort name lookup.
 *
 * When TypeScript's resolver returns no symbol (or returns one with
 * no usable declaration — common for cross-package `dist/*.d.ts`
 * cases), we fall back to a simpleName lookup against the catalog.
 *
 * Returns 'unknown'/'medium' for an unambiguous single-candidate
 * match; otherwise UNRESOLVED.
 */

import type { Catalog, FunctionOccurrence, ResolverVerdict } from '@opensip-cli/graph';

const UNRESOLVED: ResolverVerdict = {
  to: [],
  resolution: 'unknown',
  confidence: 'low',
};

export function resolveByCatalogFallback(simpleName: string, catalog: Catalog): ResolverVerdict {
  if (!Object.hasOwn(catalog.functions, simpleName)) return UNRESOLVED;
  const candidates: readonly FunctionOccurrence[] | undefined = catalog.functions[simpleName];
  if (!candidates || candidates.length === 0) return UNRESOLVED;
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only) {
      return { to: [only.bodyHash], resolution: 'unknown', confidence: 'medium' };
    }
  }
  return UNRESOLVED;
}
