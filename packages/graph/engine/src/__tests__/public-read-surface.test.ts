import { logger } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { classifyCatalog, computeFilesFingerprint } from '../cache/invalidate.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { buildFeatures } from '../pipeline/features.js';
import { buildIndexes } from '../pipeline/indexes.js';
import * as read from '../read/index.js';
import { orphanSubtreeRule } from '../rules/orphan-subtree.js';

import type { Catalog, FunctionOccurrence } from '../types.js';

const runGraphMock = vi.hoisted(() => vi.fn());

vi.mock('../cli/orchestrate.js', () => ({ runGraph: runGraphMock }));

const EXPECTED = [
  'readCatalogIdentity',
  'loadCatalogGeneration',
  'loadGraphReadConfig',
  'rebuildCatalog',
  'buildGraphReadIndexes',
  'deriveGraphReadFeatures',
  'evaluateGraphOrphans',
  'classifyGraphReadCatalog',
  'computeGraphReadFilesFingerprint',
  'matchesGraphSourceFilterWithRoles',
  'matchesFilePrefix',
  'compileSourceRoleMatcher',
  'effectiveTestSource',
  'MAX_AUDIT_SOURCE_ROLE_FILES',
  'compareCodePointStrings',
  'codePointSortKey',
  'continuationToken',
  'toGraphSymbolRef',
  'graphPackageOf',
  'toGraphPackageName',
  'GRAPH_SYMBOL_PATH_MAX',
  'GRAPH_SYMBOL_NAME_MAX',
  'GRAPH_SYMBOL_PACKAGE_MAX',
  'verifyCatalogInputs',
  'isSafeAdapterDescriptor',
  'makeFacet',
  'mergeFacet',
  'rollupFacets',
  'facetsFromFlatCoverage',
  'UNREQUESTED_FACET',
  'buildOccurrenceCallView',
  'buildPackageEvidence',
  'buildPackageScc',
  'packageDependencyStableKey',
  'packageCallEvidenceStableKey',
  'packageImportEvidenceStableKey',
  'searchSymbolOccurrences',
  'symbolSearchStableKey',
  'compareSymbolRefs',
  'buildArchitectureView',
  'packageEdgeStableKey',
  'hotspotStableKey',
].sort();

const BUILT_AT = '2026-07-09T00:00:00.000Z';

function occurrence(
  bodyHash: string,
  simpleName: string,
  calls: FunctionOccurrence['calls'] = [],
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: simpleName,
    filePath: `src/${simpleName}.ts`,
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
    calls,
  };
}

function makeCatalog(): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: BUILT_AT,
    cacheKey: 'test-cache-key',
    filesFingerprint: '0',
    functions: {
      caller: [
        occurrence('caller-hash', 'caller', [
          {
            to: ['target-hash'],
            line: 2,
            column: 0,
            resolution: 'static',
            confidence: 'high',
            text: 'target()',
          },
        ]),
      ],
      target: [occurrence('target-hash', 'target')],
    },
  };
}

afterEach(() => {
  runGraphMock.mockReset();
  vi.restoreAllMocks();
});

describe('@opensip-cli/graph/read public surface', () => {
  it('exposes exactly the locked value surface', () => {
    const actual = Object.keys(read)
      .filter((key) => (read as Record<string, unknown>)[key] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED);
  });

  it('locks read-facing types without exposing orchestration types', () => {
    expectTypeOf<read.GraphReadError>().toEqualTypeOf<{
      readonly code: string;
      readonly operation: read.GraphReadOperation;
      readonly message: string;
    }>();
    expectTypeOf<read.RebuildCatalogInput>().toEqualTypeOf<{
      readonly cwd: string;
      readonly datastore?: DataStore;
    }>();
    // @ts-expect-error RunGraphInput is orchestration-internal.
    expectTypeOf<read.RunGraphInput>();
    // @ts-expect-error RunGraphResult is orchestration-internal.
    expectTypeOf<read.RunGraphResult>();
  });

  it('does not export repository, rule, orchestration, or raw-handle values', () => {
    for (const leak of [
      'CatalogRepo',
      'orphanSubtreeRule',
      'runGraph',
      'buildIndexes',
      'requireDrizzleHandle',
    ]) {
      expect(read).not.toHaveProperty(leak);
    }
  });

  it('reuses Spec 20 CatalogIdentity without a second identity contract', () => {
    expectTypeOf<read.CatalogIdentity>().toEqualTypeOf<{
      readonly language: string;
      readonly cacheKey: string;
      readonly filesFingerprint: string;
      readonly builtAt: string;
    }>();
    expectTypeOf<read.GraphSymbolRef>().toHaveProperty('symbolId');
    expectTypeOf<read.GraphSourceFilter>().toHaveProperty('sourceScope');
    expectTypeOf<read.PackageDependencyEvidence>().toEqualTypeOf<
      read.PackageCallEvidence | read.PackageImportEvidence
    >();
  });

  it('exposes FeatureTable as a type without adding a runtime export', () => {
    // MCP consumes graph feature evidence through the read facade (ADR-0151);
    // FeatureTable must be reachable as a TYPE. A type-only re-export must never
    // add a runtime key — the value surface stays exactly EXPECTED.
    expectTypeOf<read.FeatureTable>().not.toBeNever();
    expect(read).not.toHaveProperty('FeatureTable');
    const runtimeKeys = Object.keys(read)
      .filter((key) => (read as Record<string, unknown>)[key] !== undefined)
      .sort();
    expect(runtimeKeys).toEqual(EXPECTED);
  });
});

describe('@opensip-cli/graph/read catalog Results', () => {
  it('reads identity without selecting a malformed payload or emitting read events', () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    try {
      new CatalogRepo(store).replaceAll(makeCatalog());
      requireDrizzleHandle(store).db.run(
        sql`UPDATE graph_catalog SET payload = ${'{secret:malformed-json'} WHERE id = 1`,
      );
      const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
      const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

      expect(read.readCatalogIdentity(store)).toEqual({
        ok: true,
        value: {
          language: 'typescript',
          cacheKey: 'test-cache-key',
          filesFingerprint: '0',
          builtAt: BUILT_AT,
        },
      });
      expect(read.readCatalogIdentity(store).ok).toBe(true);
      expect(info).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it('preserves missing as ok(null) for identity and generation reads', () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    try {
      expect(read.readCatalogIdentity(store)).toEqual({
        ok: true,
        value: null,
      });
      expect(read.loadCatalogGeneration(store)).toEqual({
        ok: true,
        value: null,
      });
    } finally {
      store.close();
    }
  });

  it('round-trips a full catalog generation', () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    try {
      const catalog = makeCatalog();
      new CatalogRepo(store).replaceAll(catalog);
      expect(read.loadCatalogGeneration(store)).toEqual({
        ok: true,
        value: catalog,
      });
    } finally {
      store.close();
    }
  });

  it('bounds identity/generation failures and logs only an allowlisted catalog code', () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    store.close();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const identity = read.readCatalogIdentity(store);
    expect(identity).toEqual({
      ok: false,
      error: {
        code: 'GRAPH.READ.CATALOG_IDENTITY',
        operation: 'catalog-identity',
        message: 'Failed to read graph catalog identity',
      },
    });
    expect(error).not.toHaveBeenCalled();

    const generation = read.loadCatalogGeneration(store);
    expect(generation).toEqual({
      ok: false,
      error: {
        code: 'GRAPH.READ.CATALOG_GENERATION',
        operation: 'catalog-generation',
        message: 'Failed to load graph catalog generation',
      },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith({
      evt: 'graph.catalog.read.error',
      module: 'graph:catalog-repo',
      code: 'GRAPH.CATALOG.READ_FAILED',
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(error.mock.calls)).not.toContain('sqlite');
  });
});

describe('@opensip-cli/graph/read algorithm parity', () => {
  it('delegates indexes, features, orphan evaluation, classification, and fingerprinting', () => {
    const catalog = makeCatalog();
    const indexes = buildIndexes(catalog);
    const columns = ['blast', 'reachableFromEntry', 'packageCoupling'] as const;
    const features = buildFeatures(catalog, indexes, {}, columns);
    const context = {
      currentLanguage: 'python',
      currentCacheKey: catalog.cacheKey,
      currentFiles: [] as readonly string[],
    };
    const files = ['/definitely/missing/a.ts', '/definitely/missing/b.ts'];
    const stableSignals = (
      signals: readonly { readonly id: string; readonly createdAt: string }[],
    ) =>
      signals.map((signal) => ({
        ...signal,
        id: '<dynamic>',
        createdAt: '<dynamic>',
      }));

    expect(read.buildGraphReadIndexes(catalog)).toEqual(indexes);
    expect(read.deriveGraphReadFeatures(catalog, indexes, {}, columns)).toEqual(features);
    expect(stableSignals(read.evaluateGraphOrphans(catalog, indexes, {}, features))).toEqual(
      stableSignals(orphanSubtreeRule.evaluate(catalog, indexes, {}, undefined, features)),
    );
    expect(read.classifyGraphReadCatalog(catalog, context)).toEqual(
      classifyCatalog(catalog, context),
    );
    expect(read.computeGraphReadFilesFingerprint(files)).toBe(computeFilesFingerprint(files));
  });
});

describe('@opensip-cli/graph/read rebuild Result', () => {
  it('returns the canonical catalog on success', async () => {
    const catalog = makeCatalog();
    runGraphMock.mockResolvedValue({ catalog });
    await expect(read.rebuildCatalog({ cwd: '/project' })).resolves.toEqual({
      ok: true,
      value: catalog,
    });
    expect(runGraphMock).toHaveBeenCalledWith({
      cwd: '/project',
      noCache: true,
    });
  });

  it('persists a cache-bypassing rebuild before returning it', async () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    try {
      const catalog = makeCatalog();
      runGraphMock.mockResolvedValue({ catalog });
      await expect(read.rebuildCatalog({ cwd: '/project', datastore: store })).resolves.toEqual({
        ok: true,
        value: catalog,
      });
      expect(new CatalogRepo(store).loadFullCatalog()).toEqual(catalog);
    } finally {
      store.close();
    }
  });

  it('maps persistence failures without returning an unpersisted generation', async () => {
    const store = DataStoreFactory.open({ backend: 'memory' });
    store.close();
    runGraphMock.mockResolvedValue({ catalog: makeCatalog() });
    await expect(read.rebuildCatalog({ cwd: '/project', datastore: store })).resolves.toEqual({
      ok: false,
      error: {
        code: 'GRAPH.READ.REBUILD_FAILED',
        operation: 'rebuild',
        message: 'Graph rebuild failed due to infrastructure error',
      },
    });
  });

  it('maps empty output to a bounded error', async () => {
    runGraphMock.mockResolvedValue({ catalog: null });
    await expect(read.rebuildCatalog({ cwd: '/project' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'GRAPH.READ.REBUILD_EMPTY',
        operation: 'rebuild',
        message: 'Graph rebuild produced an empty catalog',
      },
    });
  });

  it('maps infrastructure throws without exposing message, cause, path, or stack', async () => {
    runGraphMock.mockRejectedValue(
      new Error('secret-token at /private/project/datastore.sqlite', {
        cause: new Error('nested secret'),
      }),
    );
    const outcome = await read.rebuildCatalog({ cwd: '/private/project' });
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'GRAPH.READ.REBUILD_FAILED',
        operation: 'rebuild',
        message: 'Graph rebuild failed due to infrastructure error',
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/secret|private|sqlite|stack|cause/i);
    if (!outcome.ok) expect(outcome.error.message.length).toBeLessThanOrEqual(160);
  });
});
