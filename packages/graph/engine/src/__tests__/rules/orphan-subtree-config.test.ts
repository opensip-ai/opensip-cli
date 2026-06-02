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
