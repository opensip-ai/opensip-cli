/**
 * findCatalogEntry — locate a catalog entry's bodyHash from a TS declaration.
 *
 * Uses hashFunctionBody (the same function stage 1 used to populate
 * the catalog) so a successful lookup is guaranteed when the
 * declaration is in the project.
 */


import { hashFunctionBody } from '../inventory-helpers/hash-body.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';
import type ts from 'typescript';

/**
 * Returns the bodyHash if the declaration's hash is present in the
 * catalog under any simpleName key. Returns null otherwise.
 */
export function findCatalogEntry(
  decl: ts.Node,
  sourceFile: ts.SourceFile,
  catalog: Catalog,
  candidateNames: readonly string[],
): string | null {
  const bodyHash = hashFunctionBody(decl, sourceFile);
  for (const name of candidateNames) {
    const candidates = lookup(catalog, name);
    if (!candidates) continue;
    const hit = candidates.find((c) => c.bodyHash === bodyHash);
    if (hit) return hit.bodyHash;
  }
  // Fallback: scan all own keys (rare path; used when caller can't
  // narrow the candidate names).
  for (const key of Object.keys(catalog.functions)) {
    const occs = lookup(catalog, key);
    if (!occs) continue;
    const hit = occs.find((c) => c.bodyHash === bodyHash);
    if (hit) return hit.bodyHash;
  }
  return null;
}

function lookup(catalog: Catalog, name: string): readonly FunctionOccurrence[] | null {
  // Object.hasOwn keeps us safe from accidental access to prototype
  // properties when the catalog is keyed by an arbitrary identifier
  // (e.g. "constructor", "toString").
  if (!Object.hasOwn(catalog.functions, name)) return null;
  const value: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
  return value ?? null;
}
