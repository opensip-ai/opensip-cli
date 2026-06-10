// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (catalog entries within a single graph build)
/**
 * Entry-point inference (shared by orphan-subtree, test-only-reachable).
 *
 * A function is an entry point if:
 *  1. It's the bin entry (declared in package.json `bin`).
 *  2. It's a Tool registration's commands handler.
 *  3. Its name matches a heuristic list (main, start, register, init, etc.).
 *  4. Its `<module-init>` is reachable (top-level statements always run).
 *  5. It's exported AND has no *external* in-project caller (someone
 *     outside the project might call it). A self-recursive edge does not
 *     count as a caller here: an exported public function whose only
 *     in-project caller is itself (e.g. a recursive renderer consumed
 *     only across a package boundary, where the cross-package call edge
 *     does not resolve) is still an external entry point — counting its
 *     own recursion as a "caller" would wrongly hide it (and its whole
 *     file-local helper subtree) as an orphan.
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

function classify(occ: FunctionOccurrence, indexes: Indexes): EntryPoint['reason'] | null {
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
  if (occ.visibility === 'exported' && !hasExternalCaller(occ, indexes)) {
    // Exported but no *external* in-project caller — likely an external
    // entry point (consumed cross-package, where the call edge may not
    // resolve). Self-recursion does not count as an external caller.
    return 'no-callers-exported';
  }
  return null;
}

/**
 * True iff some in-project occurrence other than `occ` itself calls it.
 * A self-recursive edge (`callers` contains `occ.bodyHash`) is excluded:
 * recursion does not make a function reachable, so an otherwise-uncalled
 * exported function must still be treated as an external entry point.
 */
function hasExternalCaller(occ: FunctionOccurrence, indexes: Indexes): boolean {
  const callers = indexes.callers.get(occ.bodyHash);
  if (callers === undefined) return false;
  for (const caller of callers) {
    if (caller !== occ.bodyHash) return true;
  }
  return false;
}
