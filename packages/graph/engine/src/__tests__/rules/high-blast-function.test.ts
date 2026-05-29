/**
 * graph:high-blast-function — verifies blast index population and the
 * hybrid percentile + floor threshold policy.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { highBlastFunctionRule } from '../../rules/high-blast-function.js';

import { makeCatalog, occ, staticCall } from './_helpers.js';

describe('graph:high-blast-function', () => {
  it('populates blastRadius for every occurrence after buildIndexes', () => {
    const leaf = occ({ bodyHash: 'leaf', simpleName: 'leaf' });
    const mid = occ({ bodyHash: 'mid', simpleName: 'mid', calls: [staticCall('leaf')] });
    const top = occ({ bodyHash: 'top', simpleName: 'top', calls: [staticCall('mid')] });
    const indexes = buildIndexes(makeCatalog([top, mid, leaf]));

    const leafScore = indexes.blastRadius.get('leaf');
    expect(leafScore).toBeDefined();
    expect(leafScore?.direct).toBe(1);       // mid → leaf
    expect(leafScore?.transitive).toBe(1);   // top reaches leaf via mid
    expect(leafScore?.score).toBeCloseTo(1 + 0.5 * 1);

    const topScore = indexes.blastRadius.get('top');
    expect(topScore?.direct).toBe(0);
    expect(topScore?.transitive).toBe(0);
  });

  it('handles caller cycles without inflating counts', () => {
    const a = occ({ bodyHash: 'a', simpleName: 'a', calls: [staticCall('b')] });
    const b = occ({ bodyHash: 'b', simpleName: 'b', calls: [staticCall('a')] });
    const indexes = buildIndexes(makeCatalog([a, b]));
    const aScore = indexes.blastRadius.get('a');
    expect(aScore?.direct).toBe(1);     // b → a
    expect(aScore?.transitive).toBe(0); // a would re-reach itself; the visited set prevents that
  });

  it('does not flag when every score is below the absolute floor', () => {
    // Two-node graph: a single caller (score=1) — well below floor=5.
    const callee = occ({ bodyHash: 'c', simpleName: 'c' });
    const caller = occ({ bodyHash: 'r', simpleName: 'r', calls: [staticCall('c')] });
    const catalog = makeCatalog([callee, caller]);
    const indexes = buildIndexes(catalog);
    const signals = highBlastFunctionRule.evaluate(catalog, indexes, {});
    expect(signals).toHaveLength(0);
  });

  it('surfaces the top-percentile function when it clears the absolute floor', () => {
    // One hub called by 10 unique callers (direct=10 → score=10, above floor=5).
    // The hub is the strict maximum, so it clears the SURFACE_PERCENTILE=5% gate.
    const hub = occ({ bodyHash: 'h', simpleName: 'hub' });
    const callers = Array.from({ length: 10 }, (_, i) =>
      occ({ bodyHash: `c${String(i)}`, simpleName: `c${String(i)}`, calls: [staticCall('h')] }),
    );
    const catalog = makeCatalog([hub, ...callers]);
    const indexes = buildIndexes(catalog);
    const signals = highBlastFunctionRule.evaluate(catalog, indexes, {});
    const hubSignal = signals.find((s) => s.metadata.simpleName === 'hub');
    expect(hubSignal).toBeDefined();
    expect(hubSignal?.severity).toBe('low');
    expect(hubSignal?.metadata.blastDirect).toBe(10);
  });

  it('skips test-file and generated occurrences', () => {
    const hub = occ({ bodyHash: 'h', simpleName: 'hub', inTestFile: true });
    const callers = Array.from({ length: 10 }, (_, i) =>
      occ({ bodyHash: `c${String(i)}`, simpleName: `c${String(i)}`, calls: [staticCall('h')] }),
    );
    const catalog = makeCatalog([hub, ...callers]);
    const indexes = buildIndexes(catalog);
    const signals = highBlastFunctionRule.evaluate(catalog, indexes, {});
    expect(signals.find((s) => s.metadata.simpleName === 'hub')).toBeUndefined();
  });
});
