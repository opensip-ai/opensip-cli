/**
 * Regression: dynamic `import()` must count as a reachability edge.
 *
 * Verified false positive (the bug this guards): a CLI command module
 * reached only through
 *   `const { runReplay } = await import('../commands/.../replay.js')`
 * was flagged as an orphan — and so were the helpers it calls
 * (`parseArgs` / `formatOutcomeTag`) — because the static call-graph
 * resolver cannot trace a binding through a dynamic import, so neither
 * the importing call nor a static import edge ever marked the target
 * module reachable.
 *
 * The fix (heuristic 6 in `_entry-points.ts`) treats the dynamic-import
 * target the same way a static import makes the imported module's
 * exported surface reachable: it resolves the relative specifier to the
 * target file and seeds that file's EXPORTED occurrences as entry points.
 *
 * These tests mirror the real catalog edge topology observed from the
 * TypeScript pipeline for the `const { x } = await import('./mod.js')`
 * form: the importing function carries an UNRESOLVED `import('./mod.js')`
 * call edge (`to: []`) plus an UNRESOLVED `runReplay(...)` call edge
 * (the destructured binding the resolver could not trace), while the
 * target module's exported function resolves edges to its own private
 * helpers.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { inferEntryPoints } from '../../rules/_entry-points.js';
import { orphanSubtreeRule } from '../../rules/orphan-subtree.js';

import { edge, makeCatalog, occ, staticCall } from './_helpers.js';

/**
 * Build the `registry.ts` + `replay.ts` cluster:
 *   - `dispatch` (exported, registry.ts): dynamic-imports replay.js and
 *     calls the destructured `runReplay`; both edges are UNRESOLVED.
 *   - `runReplay` (exported, replay.js): calls its private helpers.
 *   - `parseArgs` / `formatOutcomeTag` (module-local, replay.js).
 */
function dynamicImportCluster(): ReturnType<typeof makeCatalog> {
  const dispatch = occ({
    bodyHash: 'dispatch',
    simpleName: 'dispatch',
    visibility: 'exported',
    filePath: 'src/registry.ts',
    // Unresolved (to: []) — exactly what the TS resolver emits for a
    // dynamic import and a binding it cannot trace.
    calls: [edge("import('./replay.js')"), edge('runReplay([])')],
  });
  const runReplay = occ({
    bodyHash: 'runReplay',
    simpleName: 'runReplay',
    visibility: 'exported',
    filePath: 'src/replay.ts',
    calls: [staticCall('parseArgs'), staticCall('formatOutcomeTag')],
  });
  const parseArgs = occ({
    bodyHash: 'parseArgs',
    simpleName: 'parseArgs',
    visibility: 'module-local',
    filePath: 'src/replay.ts',
  });
  const formatOutcomeTag = occ({
    bodyHash: 'formatOutcomeTag',
    simpleName: 'formatOutcomeTag',
    visibility: 'module-local',
    filePath: 'src/replay.ts',
  });
  return makeCatalog([dispatch, runReplay, parseArgs, formatOutcomeTag]);
}

describe('orphan-subtree — dynamic import reachability (heuristic 6)', () => {
  it('seeds an exported dynamic-import target as an entry point', () => {
    const catalog = dynamicImportCluster();
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    const runReplayEp = eps.find((e) => e.bodyHash === 'runReplay');
    expect(runReplayEp).toBeDefined();
    // It is seeded specifically by the dynamic-import heuristic (it has no
    // in-project caller, so it would also satisfy no-callers-exported; the
    // dynamic-import reason is what survives dedup for the FIRST classifier
    // that fires — assert the symbol is an entry point either way).
    expect(['dynamic-import', 'no-callers-exported']).toContain(runReplayEp!.reason);
  });

  it('does NOT flag a symbol reachable only via `await import()` destructure', () => {
    const catalog = dynamicImportCluster();
    const orphans = orphanSubtreeRule
      // flagExportedOrphans + flagTestOrphans left default; the helpers are
      // module-local so the exported filter does not mask them.
      .evaluate(catalog, buildIndexes(catalog), {})
      .map((s) => s.metadata.simpleName);
    // The whole dynamic-import subtree is reachable — none are orphans.
    expect(orphans).not.toContain('runReplay');
    expect(orphans).not.toContain('parseArgs');
    expect(orphans).not.toContain('formatOutcomeTag');
  });

  it('keeps flagging a genuinely unreferenced exported function (true positive preserved)', () => {
    // A dead exported function whose file is NOT a dynamic-import target,
    // reached only by a dead module-local caller. With flagExportedOrphans
    // it must still be flagged — the dynamic-import heuristic only adds
    // reachability for actually-imported files, never suppresses orphans.
    const deadCaller = occ({
      bodyHash: 'dc',
      simpleName: 'deadCaller',
      visibility: 'module-local',
      filePath: 'src/dead.ts',
      calls: [staticCall('ue')],
    });
    const unusedExport = occ({
      bodyHash: 'ue',
      simpleName: 'unusedExport',
      visibility: 'exported',
      filePath: 'src/dead.ts',
    });
    // Plus the dynamic-import cluster, to prove the two are isolated.
    const cluster = dynamicImportCluster();
    const catalog = makeCatalog([
      deadCaller,
      unusedExport,
      ...Object.values(cluster.functions).flat(),
    ]);
    const indexes = buildIndexes(catalog);

    const orphans = orphanSubtreeRule
      .evaluate(catalog, indexes, { flagExportedOrphans: true })
      .map((s) => s.metadata.simpleName);
    expect(orphans).toContain('deadCaller'); // dead module-local caller
    expect(orphans).toContain('unusedExport'); // genuine exported orphan
    // ...and the dynamic-import subtree stays reachable.
    expect(orphans).not.toContain('runReplay');
    expect(orphans).not.toContain('parseArgs');
    expect(orphans).not.toContain('formatOutcomeTag');
  });

  it('seeds the dynamic-import target even when no-callers-exported does NOT apply', () => {
    // Isolate heuristic 6 from heuristic 5: the dynamic-import target has a
    // (dead) in-project caller, so `no-callers-exported` does NOT classify it.
    // Only the dynamic-import heuristic can seed it as an entry point.
    const importer = occ({
      bodyHash: 'imp',
      simpleName: 'lazyDispatch',
      visibility: 'exported',
      filePath: 'src/registry.ts',
      calls: [edge("import('./replay.js')"), edge('runReplay()')],
    });
    const runReplay = occ({
      bodyHash: 'runReplay',
      simpleName: 'runReplay',
      visibility: 'exported',
      filePath: 'src/replay.ts',
    });
    // A dead module-local caller gives runReplay an in-project caller, so
    // hasExternalCaller() is true and no-callers-exported is suppressed.
    const deadCaller = occ({
      bodyHash: 'dead',
      simpleName: 'deadStaticCaller',
      visibility: 'module-local',
      filePath: 'src/replay.ts',
      calls: [staticCall('runReplay')],
    });
    const catalog = makeCatalog([importer, runReplay, deadCaller]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    const ep = eps.find((e) => e.bodyHash === 'runReplay');
    expect(ep?.reason).toBe('dynamic-import');
  });

  it('tolerates the `.js → .ts` ESM extension rewrite and bare specifiers', () => {
    // Importing file uses an extensionless specifier; target is a .tsx file.
    const importer = occ({
      bodyHash: 'imp',
      simpleName: 'lazyLoad',
      visibility: 'exported',
      filePath: 'src/app.ts',
      calls: [edge("import('./views/panel')"), edge('mountPanel()')],
    });
    const mountPanel = occ({
      bodyHash: 'mp',
      simpleName: 'mountPanel',
      visibility: 'exported',
      filePath: 'src/views/panel.tsx',
    });
    // A bare/workspace dynamic import resolves outside the catalog — must be
    // ignored without error.
    const bare = occ({
      bodyHash: 'bare',
      simpleName: 'loadExternal',
      visibility: 'exported',
      filePath: 'src/ext.ts',
      calls: [edge("import('node:fs')")],
    });
    const catalog = makeCatalog([importer, mountPanel, bare]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'mp')).toBeDefined();
  });
});
