/**
 * Tests for the shared entry-point inference helper.
 *
 * Coverage of the three classification reasons emitted today:
 * module-init, name-match, no-callers-exported.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { inferEntryPoints } from '../../rules/_entry-points.js';

import { makeCatalog, occ, staticCall } from './_helpers.js';

describe('inferEntryPoints', () => {
  it('classifies module-init occurrences as entry points', () => {
    const init = occ({ bodyHash: 'mi', simpleName: '<module-init:a.ts>', kind: 'module-init' });
    const catalog = makeCatalog([init]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'mi')?.reason).toBe('module-init');
  });

  it('matches well-known entry-point names (main, run, start, init, register, initialize, bootstrap)', () => {
    const candidates = ['main', 'run', 'start', 'init', 'register', 'initialize', 'bootstrap'];
    const occs = candidates.map((n, i) => occ({ bodyHash: `h${i.toString()}`, simpleName: n }));
    const catalog = makeCatalog(occs);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    for (const o of occs) {
      expect(eps.find((e) => e.bodyHash === o.bodyHash)?.reason).toBe('name-match');
    }
  });

  it('classifies an exported, never-called function as no-callers-exported', () => {
    const ep = occ({ bodyHash: 'e', simpleName: 'externalApi', visibility: 'exported' });
    const catalog = makeCatalog([ep]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'e')?.reason).toBe('no-callers-exported');
  });

  it('does not classify an exported function with callers', () => {
    const target = occ({ bodyHash: 't', simpleName: 'target', visibility: 'exported' });
    const caller = occ({ bodyHash: 'c', simpleName: 'caller', calls: [staticCall('t')] });
    const catalog = makeCatalog([target, caller]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 't')).toBeUndefined();
  });

  it('does not classify a module-local function with no callers', () => {
    const helper = occ({ bodyHash: 'h', simpleName: 'helper', visibility: 'module-local' });
    const catalog = makeCatalog([helper]);
    const eps = inferEntryPoints(catalog, buildIndexes(catalog));
    expect(eps.find((e) => e.bodyHash === 'h')).toBeUndefined();
  });
});
