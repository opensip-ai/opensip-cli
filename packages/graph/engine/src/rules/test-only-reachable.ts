/**
 * graph:test-only-reachable — flag functions whose only callers live
 * in test files. Productive code should not depend on tests; functions
 * called *exclusively* from test files are likely test fixtures that
 * should live in __tests__/, not in the production tree.
 */

import { createSignal } from '@opensip-tools/core';

import { approximateSuffix } from './_approximation.js';
import { inferEntryPoints } from './_entry-points.js';
import { applySeverityOverride } from './_severity-override.js';
import { defineRule } from './define-rule.js';

import type { Indexes, Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

export const testOnlyReachableRule = defineRule({
  slug: 'graph:test-only-reachable',
  defaultSeverity: 'warning',
  featureDeps: ['reachableOnlyFromTests'],
  evaluate({ catalog, indexes, features, config }): readonly Signal[] {
    // The reachableOnlyFromTests feature column folds the not-prod-reachable +
    // has-callers + all-callers-in-test predicate. When features are absent
    // (3/4-arg test calls), fall back to the local prod-reachability BFS — the
    // canonical home is now pipeline/features.ts. Compute the fallback set
    // ONLY when needed.
    const reachableFromProd: ReadonlySet<string> = features
      ? new Set()
      : bfsReachable(computeProductionEntries(catalog, indexes), indexes);
    const isTestOnly = (h: string): boolean =>
      features
        ? features.function.get(h)?.reachableOnlyFromTests === true
        : computeTestOnlyLocal(h, indexes, reachableFromProd);
    // Missing prod-caller edges on a fast catalog can fake "test-only".
    const caveat = approximateSuffix(catalog);
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (occ.kind === 'module-init') continue;
      if (occ.inTestFile) continue;                  // Tests-of-tests are fine.
      if (occ.definedInGenerated) continue;
      if (!isTestOnly(occ.bodyHash)) continue;       // not-prod-reachable + all-test callers
      // Skip exports — they may be intentionally test-callable APIs.
      if (occ.visibility === 'exported') continue;
      const callers = indexes.callers.get(occ.bodyHash) ?? [];
      signals.push(
        createSignal({
          source: 'graph',
          severity: applySeverityOverride('low', 'graph:test-only-reachable', config),
          category: 'testing',
          ruleId: 'graph:test-only-reachable',
          message: `${occ.simpleName} is reached only from test files.${caveat}`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion: 'Move this function to a __tests__/ helper or co-locate it with its tests.',
          metadata: {
            qualifiedName: occ.qualifiedName,
            testCallers: callers.length,
          },
        }),
      );
    }
    return signals;
  },
});

/**
 * Features-absent fallback for the `reachableOnlyFromTests` column: a function
 * is test-only-reachable when it is NOT reachable from any production entry,
 * HAS callers, and ALL of its callers live in test files. Byte-equivalent to
 * the canonical computation in `pipeline/features.ts` (`isReachableOnlyFromTests`).
 */
function computeTestOnlyLocal(
  hash: string,
  indexes: Indexes,
  reachableFromProd: ReadonlySet<string>,
): boolean {
  if (reachableFromProd.has(hash)) return false;
  const callers = indexes.callers.get(hash) ?? [];
  if (callers.length === 0) return false;
  return callers.every((h) => indexes.byBodyHash.get(h)?.inTestFile === true);
}

function computeProductionEntries(catalog: Parameters<Rule['evaluate']>[0], indexes: Indexes): Set<string> {
  const out = new Set<string>();
  for (const ep of inferEntryPoints(catalog, indexes)) {
    const occ = indexes.byBodyHash.get(ep.bodyHash);
    /* v8 ignore next */
    if (!occ) continue;
    if (occ.inTestFile) continue;                    // Test-runner entries don't count.
    out.add(ep.bodyHash);
  }
  return out;
}

function bfsReachable(seeds: ReadonlySet<string>, indexes: Indexes): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue: string[] = [...seeds];
  while (queue.length > 0) {
    const cur = queue.shift();
    /* v8 ignore next */
    if (cur === undefined || visited.has(cur)) continue;
    visited.add(cur);
    const next = indexes.callees.get(cur) ?? [];
    for (const n of next) if (!visited.has(n)) queue.push(n);
  }
  return visited;
}
