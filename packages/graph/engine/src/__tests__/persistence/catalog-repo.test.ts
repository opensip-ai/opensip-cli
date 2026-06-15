import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogRepo } from '../../persistence/catalog-repo.js';
import { buildFeatures, toPersistedFeatures } from '../../pipeline/features.js';
import { buildIndexes } from '../../pipeline/indexes.js';

import type { Catalog, FunctionOccurrence, PersistedFeatures } from '../../types.js';

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-05-22T00:00:00.000Z',
    cacheKey: 'ts-5.7.3-test',
    filesFingerprint: '0\n',
    functions: {},
    ...over,
  };
}

let datastore: DataStore;
let repo: CatalogRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new CatalogRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('CatalogRepo', () => {
  it('hasAnyCatalog returns false on empty store', () => {
    expect(repo.hasAnyCatalog()).toBe(false);
  });

  it('replaceAll then loadFullCatalog round-trips a catalog', () => {
    const c = makeCatalog({
      functions: {
        foo: [
          {
            bodyHash: 'h1',
            simpleName: 'foo',
            qualifiedName: 'foo',
            filePath: 'a.ts',
            line: 1,
            column: 0,
            endLine: 5,
            kind: 'function-declaration',
            params: [],
            returnType: null,
            enclosingClass: null,
            decorators: [],
            visibility: 'exported',
            inTestFile: false,
            definedInGenerated: false,
            calls: [],
          },
        ],
      },
    });
    repo.replaceAll(c);
    expect(repo.hasAnyCatalog()).toBe(true);
    const loaded = repo.loadFullCatalog();
    expect(loaded).not.toBeNull();
    expect(loaded?.language).toBe('typescript');
    expect(Object.keys(loaded?.functions ?? {})).toContain('foo');
  });

  it('replaceAll with a second catalog overwrites the first', () => {
    repo.replaceAll(makeCatalog({ language: 'typescript' }));
    repo.replaceAll(makeCatalog({ language: 'python' }));
    expect(repo.loadFullCatalog()?.language).toBe('python');
  });

  it('loadFullCatalog returns null on empty store', () => {
    expect(repo.loadFullCatalog()).toBeNull();
  });

  it('falls back to empty filesFingerprint when input lacks it', () => {
    const { filesFingerprint, ...withoutFp } = makeCatalog();
    void filesFingerprint;
    repo.replaceAll(withoutFp);
    expect(repo.loadFullCatalog()?.filesFingerprint).toBeUndefined();
  });

  it('replaceAll error branch propagates after datastore close', () => {
    datastore.close();
    expect(() => repo.replaceAll(makeCatalog())).toThrow();
  });

  it('loadFullCatalog error branch propagates after datastore close', () => {
    datastore.close();
    expect(() => repo.loadFullCatalog()).toThrow();
  });
});

function fnOcc(
  over: Partial<FunctionOccurrence> & { bodyHash: string; simpleName: string },
): FunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    filePath: `packages/core/src/${over.simpleName}.ts`,
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

function featuresPayload(): PersistedFeatures {
  const functions = {
    a: [
      fnOcc({
        bodyHash: 'a',
        simpleName: 'a',
        endLine: 12,
        calls: [
          { to: ['b'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'b()' },
        ],
      }),
    ],
    b: [fnOcc({ bodyHash: 'b', simpleName: 'b' })],
  };
  const catalog = makeCatalog({ functions });
  const indexes = buildIndexes(catalog);
  const requested = ['bodyLines', 'blast', 'scc', 'packageCoupling'] as const;
  const table = buildFeatures(catalog, indexes, {}, requested);
  return toPersistedFeatures(table, requested);
}

describe('CatalogRepo — features (Plan C)', () => {
  it('round-trips a features payload (Maps→records intact)', () => {
    const features = featuresPayload();
    repo.replaceAll(
      makeCatalog({
        functions: {
          a: [
            fnOcc({
              bodyHash: 'a',
              simpleName: 'a',
              endLine: 12,
              calls: [
                {
                  to: ['b'],
                  line: 1,
                  column: 0,
                  resolution: 'static',
                  confidence: 'high',
                  text: 'b()',
                },
              ],
            }),
          ],
          b: [fnOcc({ bodyHash: 'b', simpleName: 'b' })],
        },
        features,
      }),
    );
    const loaded = repo.loadFullCatalog();
    expect(loaded?.features).toEqual(features);
    expect(loaded?.features?.function?.a?.bodyLines).toBe(12);
  });

  it('exposes the same features through the GraphCatalog contract', () => {
    const features = featuresPayload();
    repo.replaceAll(
      makeCatalog({
        functions: {
          a: [
            fnOcc({
              bodyHash: 'a',
              simpleName: 'a',
              endLine: 12,
              calls: [
                {
                  to: ['b'],
                  line: 1,
                  column: 0,
                  resolution: 'static',
                  confidence: 'high',
                  text: 'b()',
                },
              ],
            }),
          ],
          b: [fnOcc({ bodyHash: 'b', simpleName: 'b' })],
        },
        features,
      }),
    );
    const contract = repo.loadCatalogContract();
    expect(contract?.features).toEqual(features);
  });

  it('lean default: a catalog without features reloads with features === undefined', () => {
    repo.replaceAll(makeCatalog());
    expect(repo.loadFullCatalog()?.features).toBeUndefined();
  });
});
