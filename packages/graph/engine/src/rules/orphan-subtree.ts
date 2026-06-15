/**
 * graph:orphan-subtree — find functions not reachable from any entry point.
 *
 * Reachability: BFS from inferEntryPoints + config.entryPointHashes
 * across the forward callees adjacency. Any FunctionOccurrence not
 * visited is an orphan. Test-only reachability is a separate rule
 * (test-only-reachable); orphan-subtree treats test files as part of
 * the graph (their module-init is its own entry by name-match).
 */

import { approximateSuffix } from './_approximation.js';
import { inferEntryPoints } from './_entry-points.js';
import { createGraphSignal } from './create-graph-signal.js';
import { defineRule } from './define-rule.js';

import type { Catalog, FeatureTable, GraphConfig, Indexes } from '../types.js';
import type { Signal } from '@opensip-cli/core';

export const orphanSubtreeRule = defineRule({
  slug: 'graph:orphan-subtree',
  defaultSeverity: 'warning',
  featureDeps: ['reachableFromEntry'],
  evaluate({ catalog, indexes, config, features }): readonly Signal[] {
    // Reachability comes from the engine feature column when present; the local
    // computeReachable is the graceful-degrade fallback (canonical home is now
    // pipeline/features.ts). Built once, outside the loop.
    const isReachable = buildReachablePredicate(catalog, indexes, config, features);
    // On a fast catalog a missing caller-edge can fake an orphan; mark it.
    const caveat = approximateSuffix(catalog);
    const orphans: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (isReachable(occ.bodyHash)) continue;
      // module-init occurrences are entry points themselves; never orphan.
      if (occ.kind === 'module-init') continue;
      // Skip occurrences with empty filePath (defensive — shouldn't happen).
      /* v8 ignore next */
      if (!occ.filePath) continue;
      // Precision filter (D3): a finding must be actionable ("delete it").
      // Exported surface is not dead for lack of an internal caller — it
      // may be consumed across a package boundary the graph can't resolve.
      if (occ.visibility === 'exported' && !config.flagExportedOrphans) continue;
      // Test-file reachability is graph:test-only-reachable's job; flagging
      // here would double-report and over-trigger on test-only helpers.
      if (occ.inTestFile && !config.flagTestOrphans) continue;
      // Decorated functions are framework-dispatched (DI, routes, CLI
      // commands), not called by name — a missing caller edge is expected.
      if (occ.decorators.length > 0) continue;
      orphans.push(
        createGraphSignal('graph:orphan-subtree', config, {
          severity: 'medium',
          category: 'quality',
          message: `${occ.simpleName} is not reachable from any inferred entry point.${caveat}`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion:
            'Either delete the function, mark it as an entry point in opensip-cli.config.yml, or add a caller.',
          metadata: {
            simpleName: occ.simpleName,
            qualifiedName: occ.qualifiedName,
            kind: occ.kind,
            visibility: occ.visibility,
            inTestFile: occ.inTestFile,
            bodyHash: occ.bodyHash,
          },
        }),
      );
    }
    return orphans;
  },
});

/**
 * Reachability predicate for a body hash. Prefers the engine
 * `reachableFromEntry` feature column (Plan C) when present; otherwise builds
 * the local reachable set once (the graceful-degrade fallback) and tests
 * membership.
 */
function buildReachablePredicate(
  catalog: Catalog,
  indexes: Indexes,
  config: GraphConfig,
  features: FeatureTable | undefined,
): (h: string) => boolean {
  if (features) {
    return (h: string): boolean => features.function.get(h)?.reachableFromEntry === true;
  }
  const reachable = computeReachable(catalog, indexes, config);
  return (h: string): boolean => reachable.has(h);
}

function computeReachable(catalog: Catalog, indexes: Indexes, config: GraphConfig): Set<string> {
  const entryPoints = inferEntryPoints(catalog, indexes);
  const seeds = new Set<string>();
  for (const ep of entryPoints) seeds.add(ep.bodyHash);
  for (const h of config.entryPointHashes ?? []) seeds.add(h);

  const visited = new Set<string>();
  const queue: string[] = [...seeds];
  while (queue.length > 0) {
    const cur = queue.shift();
    /* v8 ignore next */
    if (cur === undefined || visited.has(cur)) continue;
    visited.add(cur);
    const next = indexes.callees.get(cur) ?? [];
    for (const n of next) {
      if (!visited.has(n)) queue.push(n);
    }
  }
  return visited;
}
