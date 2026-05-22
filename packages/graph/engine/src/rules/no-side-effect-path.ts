/**
 * graph:no-side-effect-path — flag functions that are pure-by-design
 * AND whose return value is discarded by at least one caller, i.e.
 * functions whose computation has no observable effect on the program.
 *
 * Heuristic, in order:
 *   1. The function's entire transitive callee set is side-effect free
 *      (no I/O, logging, mutation, or unresolved edges).
 *   2. At least one inbound caller invokes this function as an
 *      ExpressionStatement (its return value is discarded).
 *
 * Step 2 is what makes the signal actionable. A pure function that
 * returns data is a feature when its return value is consumed
 * (`const x = pureHelper(...)`); it is dead code when the value is
 * thrown away (`pureHelper(...);` as a standalone statement).
 *
 * Catalogs from older runs that lack the `discarded` field on call
 * edges fall back to the legacy "any pure callee" check.
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
      if (!hasDiscardedCaller(occ, indexes)) continue;
      signals.push(
        createSignal({
          source: 'graph',
          severity: 'low',
          category: 'quality',
          ruleId: 'graph:no-side-effect-path',
          message: `${occ.simpleName} is pure but at least one caller discards its return value, so the call has no observable effect.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion: 'Either consume the return value at the call site, or remove the call.',
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

/**
 * True when at least one caller invokes this function as an
 * ExpressionStatement (return value discarded). Catalogs that
 * predate the `discarded` field surface every edge as undefined,
 * which we treat as "unknown" — fall back to the prior behavior
 * (always pass) so older catalogs aren't silently filtered out.
 */
function hasDiscardedCaller(occ: FunctionOccurrence, indexes: Indexes): boolean {
  const callerHashes = indexes.callers.get(occ.bodyHash) ?? [];
  if (callerHashes.length === 0) return false;
  let sawDiscardedField = false;
  for (const callerHash of callerHashes) {
    const caller = indexes.byBodyHash.get(callerHash);
    /* v8 ignore next */
    if (!caller) continue;
    for (const edge of caller.calls) {
      if (!edge.to.includes(occ.bodyHash)) continue;
      if (edge.discarded === undefined) continue;
      sawDiscardedField = true;
      if (edge.discarded) return true;
    }
  }
  // No edge carried a `discarded` field — older catalog. Preserve the
  // pre-refinement behavior so we don't drop legitimate signals.
  return !sawDiscardedField;
}

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
