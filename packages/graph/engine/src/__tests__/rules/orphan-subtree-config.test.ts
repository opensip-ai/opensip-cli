/**
 * Configuration paths for orphan-subtree.
 *
 * Covers the `entryPointHashes` config override and skipping of
 * occurrences with empty filePath (defensive guard).
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { orphanSubtreeRule } from '../../rules/orphan-subtree.js';

import { makeCatalog, occ, staticCall } from './_helpers.js';

describe('orphan-subtree config behavior', () => {
  it('respects config.entryPointHashes — orphan becomes reachable when added as entry', () => {
    const reachableViaOrphan = occ({ bodyHash: 'r', simpleName: 'reachableViaOrphan' });
    const opaque = occ({
      bodyHash: 'o',
      simpleName: 'opaque',
      visibility: 'module-local',
      calls: [staticCall('r')],
    });
    const catalog = makeCatalog([opaque, reachableViaOrphan]);
    const indexes = buildIndexes(catalog);

    // No config: opaque is orphan AND reachableViaOrphan is orphan too
    const without = orphanSubtreeRule.evaluate(catalog, indexes, {});
    const namesNoConfig = without.map((s) => s.metadata.simpleName);
    expect(namesNoConfig).toContain('opaque');
    expect(namesNoConfig).toContain('reachableViaOrphan');

    // With opaque as a manual entry point: opaque is no longer orphan
    // and reachableViaOrphan is reached transitively.
    const withCfg = orphanSubtreeRule.evaluate(catalog, indexes, { entryPointHashes: ['o'] });
    const names = withCfg.map((s) => s.metadata.simpleName);
    expect(names).not.toContain('opaque');
    expect(names).not.toContain('reachableViaOrphan');
  });

  it('skips occurrences with empty filePath defensively', () => {
    const a = occ({ bodyHash: 'a', simpleName: 'fileless', filePath: '' });
    const catalog = makeCatalog([a]);
    const indexes = buildIndexes(catalog);
    const signals = orphanSubtreeRule.evaluate(catalog, indexes, {});
    expect(signals.find((s) => s.metadata.simpleName === 'fileless')).toBeUndefined();
  });

  it('reaches a callee of a body-twin that lost the byBodyHash slot (ADR-0003)', () => {
    // `twin` (body hash T) exists in two files; each twin calls a different
    // private helper. byBodyHash keeps one winner — without twin-aware
    // adjacency the losing twin's helper would be a false orphan.
    const twinA = occ({ bodyHash: 'T', simpleName: 'twin', filePath: 'src/a.ts', calls: [staticCall('privA')] });
    const twinB = occ({ bodyHash: 'T', simpleName: 'twin', filePath: 'src/b.ts', calls: [staticCall('privB')] });
    const privA = occ({ bodyHash: 'privA', simpleName: 'privA', filePath: 'src/a.ts' });
    const privB = occ({ bodyHash: 'privB', simpleName: 'privB', filePath: 'src/b.ts' });
    const mi = occ({ bodyHash: 'mi', simpleName: '<module-init:a.ts>', kind: 'module-init', calls: [staticCall('T')] });
    const catalog = makeCatalog([mi, twinA, twinB, privA, privB]);
    const orphans = orphanSubtreeRule
      .evaluate(catalog, buildIndexes(catalog), {})
      .map((s) => s.metadata.simpleName);
    // Both privates are reached via their own twin's edges — neither is orphaned.
    expect(orphans).not.toContain('privA');
    expect(orphans).not.toContain('privB');
  });

  it('flags a genuinely-dead module-local, zero-caller, non-test, non-decorated function (D3 guard)', () => {
    const dead = occ({ bodyHash: 'd', simpleName: 'deadHelper', visibility: 'module-local' });
    const catalog = makeCatalog([dead]);
    const orphans = orphanSubtreeRule
      .evaluate(catalog, buildIndexes(catalog), {})
      .map((s) => s.metadata.simpleName);
    expect(orphans).toContain('deadHelper');
  });

  it('does not flag exported zero-caller functions by default; flagExportedOrphans restores them (D3/D4)', () => {
    // An exported zero-caller function is an inferred entry point
    // (no-callers-exported), so it is reachable and never an orphan
    // regardless of the filter. Use an exported function reached only
    // by a *dead* caller so it is genuinely unreachable, isolating the
    // visibility filter from entry-point inference.
    const deadCaller = occ({
      bodyHash: 'dc',
      simpleName: 'deadCaller',
      visibility: 'module-local',
      calls: [staticCall('pub')],
    });
    const pub = occ({ bodyHash: 'pub', simpleName: 'publicSurface', visibility: 'exported' });
    const catalog = makeCatalog([deadCaller, pub]);
    const indexes = buildIndexes(catalog);

    // Default: deadCaller (module-local, unreachable) IS flagged; the
    // exported pub is NOT (it has a caller so it's not an inferred entry,
    // but the exported filter suppresses it).
    const def = orphanSubtreeRule.evaluate(catalog, indexes, {}).map((s) => s.metadata.simpleName);
    expect(def).toContain('deadCaller');
    expect(def).not.toContain('publicSurface');

    // flagExportedOrphans: true restores the exported case.
    const flagged = orphanSubtreeRule
      .evaluate(catalog, indexes, { flagExportedOrphans: true })
      .map((s) => s.metadata.simpleName);
    expect(flagged).toContain('publicSurface');
  });

  it('does not flag inTestFile helpers by default; flagTestOrphans restores them (D3/D4)', () => {
    const testHelper = occ({
      bodyHash: 'th',
      simpleName: 'testHelper',
      visibility: 'module-local',
      inTestFile: true,
      filePath: 'src/a.test.ts',
    });
    const catalog = makeCatalog([testHelper]);
    const indexes = buildIndexes(catalog);

    const def = orphanSubtreeRule.evaluate(catalog, indexes, {}).map((s) => s.metadata.simpleName);
    expect(def).not.toContain('testHelper');

    const flagged = orphanSubtreeRule
      .evaluate(catalog, indexes, { flagTestOrphans: true })
      .map((s) => s.metadata.simpleName);
    expect(flagged).toContain('testHelper');
  });

  it('does not flag decorated functions (framework-dispatched) as orphans (D3)', () => {
    const decorated = occ({
      bodyHash: 'dec',
      simpleName: 'handler',
      visibility: 'module-local',
      decorators: ['Get'],
    });
    const catalog = makeCatalog([decorated]);
    const orphans = orphanSubtreeRule
      .evaluate(catalog, buildIndexes(catalog), {})
      .map((s) => s.metadata.simpleName);
    expect(orphans).not.toContain('handler');
  });

  it('does not flag an exported recursive renderer or its file-local helpers (D2 + D3)', () => {
    // End-to-end mirror of the cli-ui/render-to-text.ts cluster: an
    // exported recursive function whose only caller is itself, plus a
    // module-local helper it calls. D2 seeds the renderer as an entry
    // point (self-edge is not an external caller); the helper is reached
    // transitively; D3's exported filter would also suppress the renderer.
    const render = occ({
      bodyHash: 'render',
      simpleName: 'renderToText',
      visibility: 'exported',
      filePath: 'src/render.ts',
      calls: [staticCall('render'), staticCall('helper')],
    });
    const helper = occ({
      bodyHash: 'helper',
      simpleName: 'spansToText',
      visibility: 'module-local',
      filePath: 'src/render.ts',
    });
    const catalog = makeCatalog([render, helper]);
    const orphans = orphanSubtreeRule
      .evaluate(catalog, buildIndexes(catalog), {})
      .map((s) => s.metadata.simpleName);
    expect(orphans).not.toContain('renderToText');
    expect(orphans).not.toContain('spansToText');
  });

  it('does not flag module-init occurrences as orphans', () => {
    const init = occ({
      bodyHash: 'mi',
      simpleName: '<module-init:a.ts>',
      kind: 'module-init',
    });
    const catalog = makeCatalog([init]);
    const indexes = buildIndexes(catalog);
    const signals = orphanSubtreeRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });
});
