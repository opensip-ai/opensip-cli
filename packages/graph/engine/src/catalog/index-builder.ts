/**
 * Build the CatalogIndex (byContentHash + callers) from a FunctionNode list.
 *
 * Always rebuilt globally, never incrementally — see spec §2.3 step 3 for
 * the rationale (silent staleness would corrupt orphan analysis).
 *
 * Polymorphic handling: a single CallSite with N entries in `resolvedTo`
 * produces N edges in the inverted `callers` index. The caller is the
 * source FunctionNode; the targets are every id in resolvedTo. This is
 * the fan-out interpretation from spec §3.3.
 */

import { parseFunctionId } from './ids.js';

import type { CatalogIndex, FunctionNode } from './types.js';

/** Build the byContentHash and callers indexes from a FunctionNode list. */
export function buildIndexes(functions: readonly FunctionNode[]): CatalogIndex {
  const byContentHash = new Map<string, string[]>();
  const callers = new Map<string, string[]>();
  for (const fn of functions) {
    indexByContentHash(fn, byContentHash);
    indexCallers(fn, callers);
  }
  // Freeze to ReadonlyMap of readonly arrays. The Map type already
  // satisfies ReadonlyMap; the array sub-type widens via the index sig.
  const byContentHashRO: ReadonlyMap<string, readonly string[]> = byContentHash;
  const callersRO: ReadonlyMap<string, readonly string[]> = callers;
  return { byContentHash: byContentHashRO, callers: callersRO };
}

function indexByContentHash(fn: FunctionNode, byContentHash: Map<string, string[]>): void {
  const parsed = parseFunctionId(fn.id);
  if (!parsed) return;
  const list = byContentHash.get(parsed.contentHash);
  if (list) list.push(fn.id);
  else byContentHash.set(parsed.contentHash, [fn.id]);
}

function indexCallers(fn: FunctionNode, callers: Map<string, string[]>): void {
  for (const call of fn.calls) {
    for (const target of call.resolvedTo) {
      addCallerEdge(target, fn.id, callers);
    }
  }
}

function addCallerEdge(target: string, callerId: string, callers: Map<string, string[]>): void {
  const list = callers.get(target);
  if (list === undefined) {
    callers.set(target, [callerId]);
    return;
  }
  // Avoid duplicate caller entries when the same fn calls the same target
  // multiple times — the rule layer treats callers as a set, not a multiset.
  if (!list.includes(callerId)) list.push(callerId);
}
