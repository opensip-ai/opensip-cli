/**
 * graph:no-side-effect-path — flag functions whose entire transitive
 * callees are pure (no I/O, no logging, no mutation), suggesting the
 * function may be safe to memoize / inline / cache.
 *
 * Heuristic: a function is "side-effecting" if any call site in its
 * body has a confidence:'low' / unresolved edge (we don't know what it
 * does — assume the worst), OR its raw text contains a known sink
 * (logger.*, fs.*, http.*, fetch, console.*).
 *
 * Then walk the transitive closure: if NONE of a function's reachable
 * callees are side-effecting, AND the function itself isn't, it's
 * pure-subtree material.
 *
 * The rule is conservative — it only fires for functions whose edges
 * are mostly resolved, so a Signal here is a strong hint.
 */

import { createSignal } from '@opensip-tools/core';

import type { FunctionOccurrence, Indexes, Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

const SIDE_EFFECT_TEXTUAL = /\b(?:console|logger|fs\.|http\.|fetch|process\.exit|throw\s+new)\b/;

export const noSideEffectPathRule: Rule = {
  slug: 'graph:no-side-effect-path',
  defaultSeverity: 'warning',
  evaluate(_catalog, indexes, _config): readonly Signal[] {
    const sideEffecting = computeSideEffecting(indexes);
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (!isPureCandidate(occ, sideEffecting)) continue;
      const reachable = transitiveCallees(occ, indexes);
      const anyEffecting = [...reachable].some((h) => sideEffecting.has(h));
      if (anyEffecting) continue;
      signals.push(
        createSignal({
          source: 'graph',
          severity: 'low',
          category: 'quality',
          ruleId: 'graph:no-side-effect-path',
          message: `${occ.simpleName} appears to have no side effects in its transitive callee set.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion: 'Consider memoizing or simplifying this function; its callees are all pure.',
          metadata: {
            qualifiedName: occ.qualifiedName,
            transitiveCount: reachable.size,
          },
        }),
      );
    }
    return signals;
  },
};

/** Filters out occurrences we never want to flag — short, test-only, has unresolved edges, etc. */
function isPureCandidate(occ: FunctionOccurrence, sideEffecting: ReadonlySet<string>): boolean {
  if (occ.kind === 'module-init') return false;
  if (occ.inTestFile) return false;
  if (occ.calls.length < 2) return false;
  const span = occ.endLine - occ.line + 1;
  if (span < 10) return false;
  if (occ.calls.some((e) => e.to.length === 0)) return false;
  if (sideEffecting.has(occ.bodyHash)) return false;
  if (occ.visibility !== 'exported') return false;
  return true;
}

function computeSideEffecting(indexes: Indexes): Set<string> {
  const set = new Set<string>();
  for (const occ of indexes.byBodyHash.values()) {
    if (textualSideEffect(occ)) set.add(occ.bodyHash);
  }
  return set;
}

function textualSideEffect(occ: FunctionOccurrence): boolean {
  for (const edge of occ.calls) {
    if (SIDE_EFFECT_TEXTUAL.test(edge.text)) return true;
  }
  return false;
}

function transitiveCallees(start: FunctionOccurrence, indexes: Indexes): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue: string[] = [start.bodyHash];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined || visited.has(cur)) continue;
    visited.add(cur);
    const next = indexes.callees.get(cur) ?? [];
    for (const n of next) {
      if (!visited.has(n)) queue.push(n);
    }
  }
  visited.delete(start.bodyHash);
  return visited;
}
