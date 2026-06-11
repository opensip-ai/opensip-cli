/**
 * Engine-level resolution-mode contract:
 *   - a Catalog without resolutionMode is treated as exact (absence ⇒ exact);
 *   - the mode round-trips through catalog persistence (the warm-run honesty
 *     guarantee — consumers read it on cache hits, not just fresh builds);
 *   - buildGraphEnvelope surfaces resolutionMode only for fast;
 *   - the approximation caveat helper reflects the tier.
 */

import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildGraphEnvelope } from '../cli/build-envelope.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { approximateSuffix, isApproximateCatalog } from '../rules/_approximation.js';

import type { Catalog, FunctionOccurrence, ResolutionMode } from '../types.js';

function catalogWith(resolutionMode: ResolutionMode | undefined): Catalog {
  const occ: FunctionOccurrence = {
    bodyHash: 'h1',
    simpleName: 'foo',
    qualifiedName: 'a.foo',
    filePath: 'a.ts',
    line: 1,
    column: 0,
    endLine: 1,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  };
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: `ts-test-${resolutionMode ?? 'none'}`,
    ...(resolutionMode ? { resolutionMode } : {}),
    functions: { foo: [occ] },
  };
}

describe('resolution-mode contract', () => {
  describe('absence ⇒ exact', () => {
    it('a catalog with no resolutionMode normalizes to exact', () => {
      const catalog = catalogWith(undefined);
      expect(catalog.resolutionMode).toBeUndefined();
      expect(catalog.resolutionMode ?? 'exact').toBe('exact');
      expect(isApproximateCatalog(catalog)).toBe(false);
    });
  });

  describe('persistence round-trip', () => {
    let datastore: DataStore;

    beforeEach(() => {
      datastore = DataStoreFactory.open({ backend: 'memory' });
    });

    afterEach(() => {
      datastore.close?.();
    });

    it('preserves resolutionMode through write + reload (warm-run honesty)', () => {
      const repo = new CatalogRepo(datastore);
      repo.replaceAll(catalogWith('fast'));
      const loaded = repo.loadFullCatalog();
      expect(loaded?.resolutionMode).toBe('fast');
    });

    it('an exact catalog reloads without a fast marker', () => {
      const repo = new CatalogRepo(datastore);
      repo.replaceAll(catalogWith('exact'));
      expect(repo.loadFullCatalog()?.resolutionMode).toBe('exact');
    });

    it('a legacy catalog (no marker) reloads as undefined ⇒ exact', () => {
      const repo = new CatalogRepo(datastore);
      repo.replaceAll(catalogWith(undefined));
      const loaded = repo.loadFullCatalog();
      expect(loaded?.resolutionMode).toBeUndefined();
    });
  });

  describe('buildGraphEnvelope', () => {
    const RUN = { signals: [], runId: 'run-1', createdAt: '2026-06-04T00:00:00.000Z' };

    it('omits resolutionMode for exact / undefined', () => {
      expect(buildGraphEnvelope(RUN).resolutionMode).toBeUndefined();
      expect(
        buildGraphEnvelope({ ...RUN, resolutionMode: 'exact' }).resolutionMode,
      ).toBeUndefined();
    });

    it('includes resolutionMode for fast', () => {
      expect(buildGraphEnvelope({ ...RUN, resolutionMode: 'fast' }).resolutionMode).toBe('fast');
    });
  });

  describe('approximateSuffix', () => {
    it('is empty for exact and a non-empty caveat for fast', () => {
      expect(approximateSuffix(catalogWith('exact'))).toBe('');
      expect(approximateSuffix(catalogWith(undefined))).toBe('');
      expect(approximateSuffix(catalogWith('fast'))).toContain('approximate');
    });
  });
});
