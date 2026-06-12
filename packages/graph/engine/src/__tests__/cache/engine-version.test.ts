/**
 * Engine-version cache invalidation (ADR-0015).
 *
 * The catalog + shard-fragment caches must invalidate when the graph
 * engine itself changes version, so a customer who upgrades opensip-cli
 * never replays a stale catalog built by the old engine. The mechanism is
 * `stampEngineVersion`, folded into the `cacheKey` at every engine-side
 * cacheKey computation — these tests pin the format and the end-to-end
 * contract that a differently-stamped catalog is rejected.
 */

import { describe, expect, it } from 'vitest';

import { ENGINE_VERSION, stampEngineVersion } from '../../cache/engine-version.js';
import { classifyCatalog, computeFilesFingerprint } from '../../cache/invalidate.js';

import type { Catalog } from '../../types.js';

describe('stampEngineVersion', () => {
  it('prefixes the adapter cacheKey with the running engine version and the default exact mode', () => {
    expect(stampEngineVersion('ts-6.0.3-exact-abc')).toBe(
      `eng=${ENGINE_VERSION}|mode=exact|ts-6.0.3-exact-abc`,
    );
  });

  it('reads a real version (not the 0.0.0 not-found sentinel)', () => {
    // Resolves @opensip-cli/graph's package.json; a 0.0.0 here would mean
    // the version walk failed and every cache would silently never invalidate.
    expect(ENGINE_VERSION).not.toBe('0.0.0');
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is polyglot — wraps every adapter prefix identically', () => {
    for (const adapterKey of ['ts-6-x', 'go-abc', 'java-abc', 'rs-abc', 'py-abc']) {
      expect(stampEngineVersion(adapterKey)).toBe(`eng=${ENGINE_VERSION}|mode=exact|${adapterKey}`);
    }
  });

  it('folds the engine MODE so exact and sharded keys never collide (ADR-0032)', () => {
    // The exact (single-program) and sharded engines share the one
    // `graph_catalog` row. Though equivalent within the budgeted residual
    // (ADR-0032 + 2026-06-10 amendment), a mode
    // switch must still be a clean cacheKey mismatch — independent cache
    // lineages, never a silent cross-engine read. Same adapter key, different
    // mode ⇒ different cacheKey.
    const exact = stampEngineVersion('ts-6.0.3-exact-abc', 'exact');
    const sharded = stampEngineVersion('ts-6.0.3-exact-abc', 'sharded');
    expect(exact).toBe(`eng=${ENGINE_VERSION}|mode=exact|ts-6.0.3-exact-abc`);
    expect(sharded).toBe(`eng=${ENGINE_VERSION}|mode=sharded|ts-6.0.3-exact-abc`);
    expect(exact).not.toBe(sharded);
  });
});

describe('engine-version invalidation contract', () => {
  // Empty file set on both sides so language + cacheKey are the only axes that
  // can differ — isolating the engine-version behavior under test.
  const emptyFingerprint = computeFilesFingerprint([]);
  const baseCatalog = (cacheKey: string): Catalog => ({
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-06-05T00:00:00.000Z',
    cacheKey,
    filesFingerprint: emptyFingerprint,
    functions: {},
  });

  it('rejects a catalog stamped by a different engine version', () => {
    // A catalog the *current* engine would accept on config/fingerprint, but
    // that was built by an older engine build — must NOT be reused.
    const staleEngineKey = 'eng=0.0.1-old|ts-6.0.3-exact-abc';
    const currentKey = stampEngineVersion('ts-6.0.3-exact-abc');
    expect(staleEngineKey).not.toBe(currentKey);

    const verdict = classifyCatalog(baseCatalog(staleEngineKey), {
      currentLanguage: 'typescript',
      currentCacheKey: currentKey,
      currentFiles: [],
    });
    expect(verdict.kind).toBe('invalid');
  });

  it('accepts a catalog stamped by the same engine version (config/fingerprint equal)', () => {
    const key = stampEngineVersion('ts-6.0.3-exact-abc');
    const verdict = classifyCatalog(baseCatalog(key), {
      currentLanguage: 'typescript',
      currentCacheKey: key,
      currentFiles: [],
    });
    expect(verdict.kind).toBe('valid');
  });
});
