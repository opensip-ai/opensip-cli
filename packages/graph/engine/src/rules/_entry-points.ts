/**
 * Entry-point inference (shared by orphan-subtree, test-only-reachable).
 *
 * A function is an entry point if:
 *  1. It's the bin entry (declared in package.json `bin`).
 *  2. It's a Tool registration's commands handler.
 *  3. Its name matches a heuristic list (main, start, register, init, etc.).
 *  4. Its `<module-init>` is reachable (top-level statements always run).
 *  5. It has no callers AND is exported (someone outside might call it).
 *
 * v0.2 ships heuristics 3, 4, 5; 1 and 2 are project-specific and
 * deferred until cross-package call resolution is reliable.
 */

import type { Catalog, FunctionOccurrence, Indexes } from '../types.js';

const NAME_HEURISTICS = new Set([
  'main',
  'run',
  'start',
  'register',
  'initialize',
  'init',
  'bootstrap',
]);

export interface EntryPoint {
  readonly bodyHash: string;
  readonly reason: 'module-init' | 'name-match' | 'no-callers-exported';
}

export function inferEntryPoints(catalog: Catalog, indexes: Indexes): readonly EntryPoint[] {
  const out: EntryPoint[] = [];
  for (const occ of indexes.byBodyHash.values()) {
    const reason = classify(occ, indexes);
    if (reason !== null) out.push({ bodyHash: occ.bodyHash, reason });
  }
  // Honor caller-supplied override at the rule level via GraphConfig
  // (handled by the consuming rule). This module returns the inferred
  // set; rules merge it with config.entryPointHashes.
  void catalog;
  return out;
}

function classify(
  occ: FunctionOccurrence,
  indexes: Indexes,
): EntryPoint['reason'] | null {
  // Every <module-init> is an entry point. Top-level statements run
  // whenever the file is part of the import closure of a real
  // entry point. We don't track import edges, so a conservative
  // approximation is "every file's module-init is alive." Combined
  // with creation edges (parent-function → nested-function), this
  // gives transitive reachability for everything except top-level
  // function declarations that are never named-called and never
  // referenced as values.
  if (occ.kind === 'module-init') return 'module-init';
  if (NAME_HEURISTICS.has(occ.simpleName)) return 'name-match';
  if (occ.visibility === 'exported' && (indexes.callers.get(occ.bodyHash)?.length ?? 0) === 0) {
    // Exported but no caller in-project — likely an external entry point.
    return 'no-callers-exported';
  }
  return null;
}
