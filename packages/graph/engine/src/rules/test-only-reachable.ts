/**
 * graph:test-only-reachable — flag functions whose only callers live
 * in test files. Productive code should not depend on tests; functions
 * called *exclusively* from test files are likely test fixtures that
 * should live in __tests__/, not in the production tree.
 */

import { createSignal } from '@opensip-tools/core';

import { inferEntryPoints } from './_entry-points.js';

import type { Indexes, Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

export const testOnlyReachableRule: Rule = {
  slug: 'graph:test-only-reachable',
  defaultSeverity: 'warning',
  evaluate(catalog, indexes, _config): readonly Signal[] {
    const productionEntries = computeProductionEntries(catalog, indexes);
    const reachableFromProd = bfsReachable(productionEntries, indexes);
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (occ.kind === 'module-init') continue;
      if (occ.inTestFile) continue;                  // Tests-of-tests are fine.
      if (occ.definedInGenerated) continue;
      if (reachableFromProd.has(occ.bodyHash)) continue;
      const callers = indexes.callers.get(occ.bodyHash) ?? [];
      if (callers.length === 0) continue;            // Orphan — covered by orphan rule.
      // Reach via tests only? All callers must be in test files AND
      // none of them can themselves be reachable from prod (covers
      // the case of a test-helper called only by other test helpers).
      const allTest = callers.every((h) => {
        const c = indexes.byBodyHash.get(h);
        return c?.inTestFile === true;
      });
      if (!allTest) continue;
      // Skip exports — they may be intentionally test-callable APIs.
      if (occ.visibility === 'exported') continue;
      signals.push(
        createSignal({
          source: 'graph',
          severity: 'low',
          category: 'testing',
          ruleId: 'graph:test-only-reachable',
          message: `${occ.simpleName} is reached only from test files.`,
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
};

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
