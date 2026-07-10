import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CatalogRepo } from '../../persistence/catalog-repo.js';
import { graphCatalog } from '../../persistence/schema.js';
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

  it.each([
    {
      adapterSelection: {
        mode: 'forced' as const,
        requestedId: 'typescript',
        selectedId: 'typescript',
      },
      engineMode: 'exact' as const,
    },
    {
      adapterSelection: { mode: 'auto' as const, selectedId: 'typescript' },
      engineMode: 'sharded' as const,
      shardCacheInputs: [
        {
          shardId: ':root',
          rootDir: '.',
        },
        {
          shardId: 'partition:3',
          rootDir: 'packages/a',
          configPath: 'packages/a/tsconfig.json',
        },
        {
          shardId: '@scope/workspace:packages/core',
          rootDir: 'packages/core',
          configPath: 'packages/core/tsconfig.json',
        },
      ],
    },
  ])('round-trips optional catalog provenance %#', (provenance) => {
    const value = makeCatalog(provenance);
    repo.replaceAll(value);
    expect(repo.loadFullCatalog()).toEqual(value);
  });

  it('loads a legacy payload without inventing provenance defaults', () => {
    repo.replaceAll(makeCatalog());
    const loaded = repo.loadFullCatalog();
    expect(loaded?.adapterSelection).toBeUndefined();
    expect(loaded?.engineMode).toBeUndefined();
    expect(loaded?.shardCacheInputs).toBeUndefined();
  });

  it.each([
    ['adapterSelection', { mode: 'forced', requestedId: '../bad', selectedId: 'typescript' }],
    ['engineMode', 'parallel'],
    ['shardCacheInputs', [{ shardId: 'a', rootDir: '../escape' }]],
    ['shardCacheInputs', [{ shardId: 'a', rootDir: '/absolute/escape' }]],
    ['shardCacheInputs', [{ shardId: 'a', rootDir: 'C:/windows/escape' }]],
    ['shardCacheInputs', [{ shardId: 'a', rootDir: 'packages\\escape' }]],
    ['shardCacheInputs', [{ shardId: 'a', rootDir: '.', surprise: true }]],
  ])('fails closed on malformed optional %s provenance', (field, value) => {
    repo.replaceAll(makeCatalog());
    const db = requireDrizzleHandle(datastore).db;
    const row = db.select().from(graphCatalog).get();
    expect(row).toBeDefined();
    const payload = { ...(row?.payload as object), [field]: value };
    db.run(sql`UPDATE graph_catalog SET payload = ${JSON.stringify(payload)} WHERE id = 1`);
    expect(() => repo.loadFullCatalog()).toThrow(/Malformed catalog/);
  });

  it('fails closed on a JSON-valid malformed base catalog container', () => {
    repo.replaceAll(makeCatalog());
    const db = requireDrizzleHandle(datastore).db;
    const row = db.select().from(graphCatalog).get();
    const payload = { ...(row?.payload as object), functions: 'not-an-object' };
    db.run(sql`UPDATE graph_catalog SET payload = ${JSON.stringify(payload)} WHERE id = 1`);
    expect(() => repo.loadFullCatalog()).toThrow('Malformed catalog payload');
  });

  it('keeps structurally bounded malformed symbol rows queryable for partial projection', () => {
    repo.replaceAll(
      makeCatalog({
        functions: { foo: [fnOcc({ bodyHash: 'foo', simpleName: 'foo' })] },
      }),
    );
    const db = requireDrizzleHandle(datastore).db;
    const row = db.select().from(graphCatalog).get();
    expect(row).toBeDefined();
    const payload = row?.payload as {
      functions: Record<string, readonly Record<string, unknown>[]>;
    };
    const firstBucket = Object.keys(payload.functions)[0];
    expect(firstBucket).toBeDefined();
    const original = firstBucket === undefined ? undefined : payload.functions[firstBucket]?.[0];
    expect(original).toBeDefined();
    const functions = {
      ...payload.functions,
      ...(firstBucket === undefined
        ? {}
        : {
            [firstBucket]: [
              {
                ...original,
                line: 0,
                kind: 'hostile-kind',
                visibility: 'hostile-visibility',
              },
            ],
          }),
    };
    db.run(
      sql`UPDATE graph_catalog SET payload = ${JSON.stringify({ ...payload, functions })} WHERE id = 1`,
    );

    const loaded = repo.loadFullCatalog();
    expect(loaded).not.toBeNull();
    expect(firstBucket === undefined ? undefined : loaded?.functions[firstBucket]?.[0]?.line).toBe(
      0,
    );
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
