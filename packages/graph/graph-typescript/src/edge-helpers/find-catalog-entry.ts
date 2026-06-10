// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (catalog entries for a single declaration site)
/**
 * findCatalogEntry — locate a catalog entry's bodyHash from a TS declaration.
 *
 * Uses hashFunctionBody (the same function stage 1 used to populate
 * the catalog) so a successful lookup is guaranteed when the
 * declaration is in the project.
 */


import { hashFunctionBody } from '../inventory-helpers/hash-body.js';

import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';
import type ts from 'typescript';

/**
 * Returns the bodyHash if the declaration's hash is present in the
 * catalog under one of `candidateNames`. Returns null otherwise.
 *
 * Matching is strictly (candidate simple name) × (body hash): the declaration's
 * hashed source body must equal a cataloged occurrence's `bodyHash` UNDER THE
 * NAME the call site addressed. The old whole-catalog hash scan (any name) was
 * removed — for an in-project declaration the correct name bucket is always one
 * of `candidateNames` (the callee/declaration name), so the scan only ever
 * fired on a `.d.ts` (bodiless) hash that happened to collide, fabricating
 * phantom edges. Cross-package (`.d.ts`) resolution now goes through
 * `resolveDeclToHash`'s export-index path, never this hasher.
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
  return null;
}

function lookup(catalog: Catalog, name: string): readonly FunctionOccurrence[] | null {
  // Object.hasOwn keeps us safe from accidental access to prototype
  // properties when the catalog is keyed by an arbitrary identifier
  // (e.g. "constructor", "toString").
  if (!Object.hasOwn(catalog.functions, name)) return null;
  const value: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
  /* v8 ignore next */
  return value ?? null;
}
