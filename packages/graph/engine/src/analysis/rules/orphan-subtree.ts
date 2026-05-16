/**
 * graph:orphan-subtree
 *
 * Fires on a function with NO callers (and no inferred entry-point status)
 * AND every transitively-reached descendant from it that is also caller-less.
 * Reports the deletable slice — the orphan plus its private callees that are
 * only reachable through the orphan.
 *
 * Conservative interpretation (spec §3.4): if a function appears in any
 * `callers` index entry — even as a polymorphic candidate — it is NOT an
 * orphan. We trade false negatives (real dead code where N-of-M impls are
 * never instantiated) for the safety of never proposing deletion of
 * polymorphically-reachable code.
 *
 * Severity: error.
 * Confidence: high when no polymorphic dispatch is involved; medium when
 * polymorphic dispatch contributes to the subtree's call edges.
 *
 * Entry-point heuristic (P3 conservative form):
 *   - Functions in test files or generated files are skipped.
 *   - Exported functions are NOT automatically treated as entry points;
 *     unused exports are a real category of orphan. Future P3+ refinements
 *     can layer in cross-package import tracking (the §3.4 externalCallers
 *     pass) to distinguish "exported and used" from "exported and unused".
 *   - A function whose name matches one of the conventional entry-point
 *     identifiers (`main`, `handler`, etc.) is also treated as a root.
 */

import type { Catalog, FunctionNode } from '../../catalog/types.js';
import type { GraphFinding } from '../types.js';

export const RULE_ID = 'graph:orphan-subtree';

const ENTRY_POINT_NAMES = new Set([
  'main',
  'handler',
  'register',
  'default',
  // Common framework entry points; tune when we add framework-aware
  // heuristics in the post-v0.1 entry-point detector.
]);

export function evaluateOrphanSubtree(catalog: Catalog): readonly GraphFinding[] {
  const byId = new Map<string, FunctionNode>();
  for (const fn of catalog.functions) byId.set(fn.id, fn);
  const callers = catalog.indexes.callers;

  const candidateRoots = findCandidateRoots(catalog.functions, callers);
  const out: GraphFinding[] = [];
  const reportedSubtreeMembers = new Set<string>();

  for (const root of candidateRoots) {
    if (reportedSubtreeMembers.has(root.id)) continue;
    const subtreeIds = collectPrivateSubtree(root, byId, callers);
    for (const id of subtreeIds) reportedSubtreeMembers.add(id);
    const members = idsToNodes(subtreeIds, byId);
    out.push(buildFinding(root, members));
  }
  return out;
}

/**
 * A function is a candidate orphan root when:
 *   - it has no caller in the inverted index;
 *   - it isn't in a test or generated file;
 *   - its name isn't on the conventional-entry-point allowlist.
 */
function findCandidateRoots(
  functions: readonly FunctionNode[],
  callers: ReadonlyMap<string, readonly string[]>,
): readonly FunctionNode[] {
  const out: FunctionNode[] = [];
  for (const fn of functions) {
    if (fn.inTestFile || fn.definedInGenerated) continue;
    if (ENTRY_POINT_NAMES.has(fn.simpleName)) continue;
    const callerList = callers.get(fn.id) ?? [];
    if (callerList.length === 0) out.push(fn);
  }
  return out;
}

function idsToNodes(
  ids: readonly string[],
  byId: ReadonlyMap<string, FunctionNode>,
): readonly FunctionNode[] {
  return ids
    .map((id) => byId.get(id))
    .filter((f): f is FunctionNode => f !== undefined);
}

function buildFinding(root: FunctionNode, members: readonly FunctionNode[]): GraphFinding {
  const lineSpan = sumLineSpan(members);
  const confidence = subtreeHasPolymorphism(members) ? 'medium' : 'high';
  return {
    ruleId: RULE_ID,
    message: `Orphan subtree: ${members.length} function${members.length === 1 ? '' : 's'}, ${lineSpan} lines, 0 reachable entry points`,
    severity: 'error',
    filePath: root.filePath,
    line: root.line,
    column: root.column,
    metadata: {
      subtreeSize: members.length,
      subtreeLines: lineSpan,
      subtreeFunctions: members.map((f) => f.qualifiedName),
      confidence,
    },
  };
}

/**
 * BFS from `root`, collecting only descendants whose every caller is itself
 * inside the discovered set. The discovered set always contains `root` (its
 * caller list is empty by definition of "candidate root"), and grows by
 * adding any callee whose call list is fully contained in the discovered
 * set.
 */
function collectPrivateSubtree(
  root: FunctionNode,
  byId: ReadonlyMap<string, FunctionNode>,
  callers: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const discovered = new Set<string>([root.id]);
  // Iterate to fixed point: with each pass, a function whose every caller
  // is already in `discovered` joins the set. This is O(n²) worst case but
  // n is bounded by subtree size, which is typically tiny.
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of byId.values()) {
      if (discovered.has(fn.id)) continue;
      const callerList = callers.get(fn.id) ?? [];
      if (callerList.length === 0) continue; // would already be its own root
      const allInSubtree = callerList.every((c) => discovered.has(c));
      if (allInSubtree) {
        discovered.add(fn.id);
        changed = true;
      }
    }
  }
  return [...discovered];
}

function sumLineSpan(fns: readonly FunctionNode[]): number {
  let total = 0;
  for (const fn of fns) total += Math.max(1, fn.endLine - fn.line + 1);
  return total;
}

function subtreeHasPolymorphism(fns: readonly FunctionNode[]): boolean {
  for (const fn of fns) {
    for (const call of fn.calls) {
      if (call.resolution === 'method-dispatch') return true;
    }
  }
  return false;
}
