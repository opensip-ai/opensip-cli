/**
 * SqliteGraphReadPort against a real in-memory DataStore (Phase 1 cutover).
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { testSelectionSnapshotSchema, type ProjectInventorySnapshot } from '@opensip-cli/contracts';
import { ephemeralProjectCacheKey, ok } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { CatalogRepo } from '@opensip-cli/graph/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { catalogGenerationKey } from '../catalog-generation-model.js';
import { decodeCursor, digestNormalizedQuery, encodeCursor } from '../graph-query-page.js';
import { SqliteGraphReadPort } from '../sqlite-graph-read-port.js';

import type { Catalog, FunctionOccurrence, GraphLanguageAdapter } from '@opensip-cli/graph';
import type { GraphAdapterRegistryReader } from '@opensip-cli/graph/read';

const BUILT_AT = '2026-05-22T00:00:00.000Z';
const PROJECT = join(tmpdir(), 'opensip-mcp-test-project');

function fnOcc(
  over: Partial<FunctionOccurrence> & {
    bodyHash: string;
    simpleName: string;
    filePath: string;
  },
): FunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
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
    package: 'pkg',
    ...over,
  };
}

function seededCatalog(builtAt = BUILT_AT): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt,
    cacheKey: 'ts-5.7.3-test',
    filesFingerprint: '0\n',
    adapterSelection: { mode: 'auto', selectedId: 'typescript' },
    engineMode: 'exact',
    functions: {
      caller: [
        fnOcc({
          bodyHash: 'h-caller',
          simpleName: 'caller',
          filePath: 'src/caller.ts',
          line: 10,
          column: 2,
          endLine: 20,
          calls: [
            {
              to: ['h-target'],
              line: 12,
              column: 4,
              resolution: 'static',
              confidence: 'high',
              text: 'target()',
            },
          ],
        }),
      ],
      target: [
        fnOcc({
          bodyHash: 'h-target',
          simpleName: 'target',
          filePath: 'src/target.ts',
        }),
      ],
      lonely1: [
        fnOcc({
          bodyHash: 'h-l1',
          simpleName: 'lonely1',
          filePath: 'src/l1.ts',
        }),
      ],
    },
  };
}

function wideCatalog(count: number): Catalog {
  const source = seededCatalog();
  return {
    ...source,
    functions: {
      target: source.functions.target,
      callers: Array.from({ length: count }, (_, index) =>
        fnOcc({
          bodyHash: `wide-${String(index)}`,
          simpleName: `wide${String(index)}`,
          filePath: `tests/wide-${String(index)}.ts`,
          inTestFile: true,
          calls: [
            {
              to: ['h-target'],
              line: 2,
              column: 1,
              resolution: 'static',
              confidence: 'high',
              text: 'target()',
            },
          ],
        }),
      ),
    },
  };
}

function wideSpanCatalog(count: number): Catalog {
  return {
    ...seededCatalog(),
    functions: {
      spans: Array.from({ length: count }, (_, index) =>
        fnOcc({
          bodyHash: `span-${String(index)}`,
          simpleName: `span${String(index)}`,
          filePath: 'src/span.ts',
          line: 1,
          column: index,
          endLine: 2,
        }),
      ),
    },
  };
}

function packageCatalog(builtAt = BUILT_AT): Catalog {
  const moduleA = fnOcc({
    bodyHash: 'module-a',
    simpleName: '<module-init:a>',
    qualifiedName: 'packages/a/src/index.ts',
    filePath: 'packages/a/src/index.ts',
    package: 'pkg-a',
    kind: 'module-init',
    dependencies: [
      { to: ['module-b'], specifier: './b.js', line: 1, column: 0 },
      { to: [], specifier: 'external-lib', line: 2, column: 0 },
    ],
  });
  const moduleB = fnOcc({
    bodyHash: 'module-b',
    simpleName: '<module-init:b>',
    qualifiedName: 'packages/b/src/index.ts',
    filePath: 'packages/b/src/index.ts',
    package: 'pkg-b',
    kind: 'module-init',
    dependencies: [{ to: ['module-a'], specifier: './a.js', line: 1, column: 0 }],
  });
  const nodeA = fnOcc({
    bodyHash: 'node-a',
    simpleName: 'nodeA',
    qualifiedName: 'pkg-a.nodeA',
    filePath: 'packages/a/src/a.ts',
    package: 'pkg-a',
    calls: [
      {
        to: ['node-b'],
        line: 2,
        column: 1,
        resolution: 'static',
        confidence: 'high',
        text: 'nodeB()',
      },
    ],
  });
  const nodeB = fnOcc({
    bodyHash: 'node-b',
    simpleName: 'nodeB',
    qualifiedName: 'pkg-b.nodeB',
    filePath: 'packages/b/src/b.ts',
    package: 'pkg-b',
    calls: [
      {
        to: ['node-a'],
        line: 2,
        column: 1,
        resolution: 'static',
        confidence: 'high',
        text: 'nodeA()',
      },
    ],
  });
  const nodeC = fnOcc({
    bodyHash: 'node-c',
    simpleName: 'nodeC',
    qualifiedName: 'pkg-c.nodeC',
    filePath: 'packages/c/src/c.ts',
    package: 'pkg-c',
    calls: [
      {
        to: ['node-a'],
        line: 2,
        column: 1,
        resolution: 'static',
        confidence: 'medium',
        text: 'nodeA()',
      },
    ],
  });
  return {
    ...seededCatalog(builtAt),
    functions: {
      moduleA: [moduleA],
      moduleB: [moduleB],
      nodeA: [nodeA],
      nodeB: [nodeB],
      nodeC: [nodeC],
    },
  };
}

function stubAdapters(): GraphAdapterRegistryReader {
  const adapter = {
    id: 'typescript',
    fileExtensions: ['.ts'],
    displayName: 'TypeScript',
    discoverFiles: () => ({ projectDirAbs: PROJECT, files: [] }),
    parseProject: () => ({ project: null, parseErrors: [] }),
    walkProject: () => ({ occurrences: {}, callSites: [], parseErrors: [] }),
    resolveCallSites: () => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => 'ts-5.7.3-test',
  } as unknown as GraphLanguageAdapter;
  return {
    size: 1,
    getAll: () => [{ id: 'typescript', adapter }],
    getById: (id) => (id === 'typescript' ? { adapter } : undefined),
  };
}

function makePort(store: DataStore): SqliteGraphReadPort {
  return new SqliteGraphReadPort({
    store,
    projectRoot: PROJECT,
    adapters: stubAdapters(),
    languageAdapters: [],
    rebuild: () => Promise.resolve(ok(seededCatalog())),
  });
}

const INVENTORY: ProjectInventorySnapshot = {
  schemaVersion: 1,
  snapshotId: `i1:${'1'.repeat(64)}`,
  metadataIdentity: `m1:${'2'.repeat(64)}`,
  project: {
    configIdentity: 'sha256:config',
    workspacePatterns: [],
    languages: ['typescript'],
    fileCount: 2,
    packageCount: 1,
  },
  packages: [
    {
      name: 'pkg',
      root: '.',
      private: true,
      exports: [],
      bins: [],
      verificationCommands: [
        { tier: 'full', cwd: '.', argv: ['vitest', 'run'], basis: 'manifest-script:test' },
      ],
      provenance: [{ source: 'manifest', detail: 'package.json' }],
    },
  ],
  files: [
    {
      path: 'src/target.ts',
      size: 10,
      modifiedMs: 1,
      roles: ['production'],
      targets: ['source'],
      languages: ['typescript'],
      evidenceSupport: {
        callable: 'supported',
        declaration: 'supported',
        reference: 'supported',
      },
      packageName: 'pkg',
      provenance: [{ source: 'target', detail: 'target:source' }],
    },
    {
      path: 'src/target.test.ts',
      size: 10,
      modifiedMs: 1,
      roles: ['test'],
      targets: ['tests'],
      languages: ['typescript'],
      evidenceSupport: {
        callable: 'supported',
        declaration: 'supported',
        reference: 'supported',
      },
      packageName: 'pkg',
      provenance: [{ source: 'target', detail: 'target:tests' }],
    },
  ],
  coverage: { status: 'complete', reasonCodes: [], observed: 2, total: 2 },
};

describe('SqliteGraphReadPort (async cutover)', () => {
  let store: DataStore;

  beforeEach(() => {
    store = DataStoreFactory.open({ backend: 'memory' });
  });

  afterEach(() => {
    store.close();
  });

  it('returns missing catalog status without error', async () => {
    const port = makePort(store);
    const status = await port.catalogStatus();
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.context.catalog.status).toBe('missing');
    expect(status.value.freshness.verification).toBe('missing');
  });

  it('returns explicit missing-graph fallbacks for impact and test selection', async () => {
    const port = makePort(store);
    const impact = await port.impactFiles(['src/target.ts']);
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.value.context.catalog.status).toBe('missing');
    expect(impact.value.data).toMatchObject({
      matchedFiles: [],
      unmatchedFiles: ['src/target.ts'],
      trust: { fallback: 'full-run', fullyVerified: false },
    });
    expect(impact.value.data.nextActions.join(' ')).toContain('refresh_graph');

    const selection = await port.selectTests(['src/target.ts'], INVENTORY);
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.value.data).toMatchObject({
      tests: [],
      uncoveredFiles: ['src/target.ts'],
      trust: { status: 'fallback' },
      graphIdentity: 'graph:missing',
      inventoryIdentity: INVENTORY.snapshotId,
      durable: false,
    });
    expect(testSelectionSnapshotSchema.safeParse(selection.value.data).success).toBe(false);
    expect(selection.value.data.commands).not.toHaveLength(0);
    expect(selection.value.coverage.complete).toBe(false);
  });

  it('serves impact, entity detail, test selection, and exact generation status', async () => {
    const baseCatalog = seededCatalog();
    const catalog: Catalog = {
      ...baseCatalog,
      functions: {
        ...baseCatalog.functions,
        targetTest: [
          fnOcc({
            bodyHash: 'h-target-test',
            simpleName: 'targetTest',
            filePath: 'src/target.test.ts',
            inTestFile: true,
            calls: [
              {
                to: ['h-target'],
                line: 2,
                column: 2,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
      },
    };
    new CatalogRepo(store).replaceAll(catalog);
    const port = makePort(store);

    const impact = await port.impactFiles(['src/target.ts'], { maxDepth: 2, top: 20 });
    expect(impact.ok).toBe(true);
    if (!impact.ok) return;
    expect(impact.value.data.changedFunctions.map((item) => item.qualifiedName)).toContain(
      'target',
    );
    expect(impact.value.data.impactedFunctions.map((item) => item.qualifiedName)).toEqual(
      expect.arrayContaining(['caller', 'targetTest']),
    );

    const entity = await port.entityDetail('src/caller.ts:10:2');
    expect(entity.ok).toBe(true);
    if (!entity.ok) return;
    expect(entity.value.data).toMatchObject({
      symbol: { symbolId: 'src/caller.ts:10:2', qualifiedName: 'caller' },
      endLine: 20,
    });

    const location = await port.symbolAtLocation('src/caller.ts', 10, 'entity');
    expect(location.ok).toBe(true);
    if (!location.ok) return;
    expect(location.value).toMatchObject({
      data: {
        candidates: [{ symbolId: 'src/caller.ts:10:2' }],
        entity: { symbol: { symbolId: 'src/caller.ts:10:2' }, endLine: 20 },
      },
      context: { catalog: { identity: impact.value.context.catalog.identity } },
    });

    const selection = await port.selectTests(['src/target.ts'], INVENTORY, {
      maxDepth: 2,
      limit: 20,
      commandLimit: 10,
      proofDetail: 'paths',
      proofLimit: 4,
    });
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.value.data.graphIdentity).toBe(impact.value.context.catalog.identity);
    expect(selection.value.data.inventoryIdentity).toBe(INVENTORY.snapshotId);
    expect(selection.value.data.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/target.test.ts', observed: false }),
      ]),
    );

    const identity = impact.value.context.catalog.identity!;
    const exact = await port.contextPointerStatus({
      owner: 'graph',
      kind: 'graph',
      id: identity,
      schemaVersion: 3,
    });
    const stale = await port.contextPointerStatus({
      owner: 'graph',
      kind: 'graph',
      id: 'g1:recorded-older-generation',
      schemaVersion: 3,
    });
    expect(exact.ok && exact.value).toMatchObject({
      status: 'stale',
      reasonCodes: expect.arrayContaining(['graph-generation-not-current']),
      currentGraphIdentity: identity,
    });
    expect(stale.ok && stale.value).toMatchObject({
      status: 'stale',
      reasonCodes: ['graph-generation-replaced'],
      currentGraphIdentity: identity,
    });
    expect(stale.ok && stale.value.pointer.id).toBe('g1:recorded-older-generation');
  });

  it('propagates impact cancellation after bounded index work has started', async () => {
    new CatalogRepo(store).replaceAll(wideCatalog(12_000));
    const port = makePort(store);
    const controller = new AbortController();
    const pending = port.impactFiles(['src/target.ts'], undefined, controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  it('propagates test-selection cancellation after reverse indexing has started', async () => {
    new CatalogRepo(store).replaceAll(wideCatalog(12_000));
    const port = makePort(store);
    const controller = new AbortController();
    const pending = port.selectTests(['src/target.ts'], INVENTORY, undefined, controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  it('cancels the get_symbol span scan after the request has started', async () => {
    new CatalogRepo(store).replaceAll(wideSpanCatalog(12_000));
    const port = makePort(store);
    const controller = new AbortController();
    const pending = port.symbolAtLocation('src/span.ts', 1, 'summary', controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  it('rejects a prior generation cursor for every paged graph operation when the catalog is missing', async () => {
    const port = makePort(store);
    const discoverFilter = {
      sourceScope: 'all',
      generated: 'include',
    } as const;
    const productionFilter = {
      sourceScope: 'production',
      generated: 'exclude',
    } as const;
    const cursorFor = (query: unknown): string =>
      encodeCursor({
        v: 1,
        projectKey: ephemeralProjectCacheKey(PROJECT),
        generationKey: `g1:${'a'.repeat(64)}`,
        queryDigest: digestNormalizedQuery(query),
        afterKey: 'prior-page-anchor',
      });
    const symbolId = 'src/target.ts:1:0';

    const outcomes = [
      [
        'searchSymbols',
        await port.searchSymbols('target', {
          cursor: cursorFor({
            op: 'searchSymbols',
            query: 'target',
            match: 'substring',
            filter: discoverFilter,
            groupBy: 'none',
            detail: 'nodes',
          }),
        }),
      ],
      [
        'traverse',
        await port.traverse({
          direction: 'callees',
          startSymbolId: symbolId,
          cursor: cursorFor({
            op: 'traverse',
            direction: 'callees',
            startSymbolId: symbolId,
            goalSymbolId: undefined,
            depth: 5,
            identity: 'occurrence',
            filter: discoverFilter,
            groupBy: 'none',
            detail: 'nodes',
          }),
        }),
      ],
      [
        'blast',
        await port.blast(symbolId, {
          cursor: cursorFor({
            op: 'blast',
            symbolId,
            filter: discoverFilter,
            groupBy: 'none',
            detail: 'summary',
          }),
        }),
      ],
      [
        'deadCode',
        await port.deadCode({
          cursor: cursorFor({
            op: 'deadCode',
            filter: discoverFilter,
            groupBy: 'none',
            detail: 'summary',
          }),
        }),
      ],
      [
        'architectureSummary',
        await port.architectureSummary({
          cursor: cursorFor({
            op: 'architectureSummary',
            filter: productionFilter,
            groupBy: 'none',
            sections: ['metrics'],
            topN: 20,
          }),
        }),
      ],
      [
        'packageDependencies',
        await port.packageDependencies({
          cursor: cursorFor({
            op: 'packageDependencies',
            edgeKind: 'call',
            direction: 'out',
            package: undefined,
            filter: productionFilter,
            groupBy: 'none',
            sampleLimit: null,
          }),
        }),
      ],
      [
        'whyDepends',
        await port.whyDepends({
          fromPackage: 'pkg-a',
          toPackage: 'pkg-b',
          cursor: cursorFor({
            op: 'whyDepends',
            edgeKind: 'combined',
            fromPackage: 'pkg-a',
            toPackage: 'pkg-b',
            filter: productionFilter,
            groupBy: 'none',
            evidenceLimit: null,
          }),
        }),
      ],
      [
        'packageCycles',
        await port.packageCycles({
          cursor: cursorFor({
            op: 'packageCycles',
            edgeKind: 'call',
            filter: productionFilter,
            groupBy: 'none',
            proofLimit: null,
          }),
        }),
      ],
    ] as const;

    for (const [operation, outcome] of outcomes) {
      expect(outcome.ok, operation).toBe(false);
      if (!outcome.ok) expect(outcome.error.code, operation).toBe('cursor-stale');
    }
  });

  it('loads a seeded catalog and serves search/traverse with context', async () => {
    new CatalogRepo(store).replaceAll(seededCatalog());
    const port = makePort(store);

    const search = await port.searchSymbols('caller');
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.value.context.catalog.status).toBe('loaded');
    expect(search.value.context.catalog.identity?.startsWith('g1:')).toBe(true);
    expect(search.value.coverage).toBeDefined();
    expect(search.value.coverage.inventory.requested).toBe(true);
    expect(search.value.data.detail).toBe('nodes');
    expect(search.value.data.symbols.some((s) => s.simpleName === 'caller')).toBe(true);
    expect(search.value.data.symbols[0]?.package).toBe('pkg');
    expect(search.value.data.symbols[0]?.symbolId.length).toBeGreaterThan(0);

    const start = search.value.data.symbols[0].symbolId;
    const walk = await port.traverse({
      direction: 'callees',
      startSymbolId: start,
      depth: 2,
    });
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.value.data.identityMode).toBe('occurrence');
    expect(walk.value.context.catalog.identity).toBe(search.value.context.catalog.identity);
  });

  it('reports malformed symbol omission and deterministically caps span candidates', async () => {
    const functions: Record<string, FunctionOccurrence[]> = {};
    for (let index = 0; index < 501; index++) {
      functions[`nested${String(index)}`] = [
        fnOcc({
          bodyHash: `nested-${String(index)}`,
          simpleName: `nested${String(index)}`,
          filePath: 'src/nested.ts',
          line: 1,
          column: index,
          endLine: 3,
        }),
      ];
    }
    functions.malformed = [
      {
        ...fnOcc({
          bodyHash: 'malformed',
          simpleName: 'malformed',
          filePath: 'src/malformed.ts',
        }),
        kind: 'invalid\u0085kind',
      } as unknown as FunctionOccurrence,
    ];
    new CatalogRepo(store).replaceAll({ ...seededCatalog(), functions });
    const port = makePort(store);

    const malformed = await port.resolveSymbolId('src/malformed.ts:1:0');
    expect(malformed.ok).toBe(true);
    if (!malformed.ok) return;
    expect(malformed.value.data).toBeUndefined();
    expect(malformed.value.coverage.complete).toBe(false);
    expect(malformed.value.coverage.truncated).toBe(false);
    expect(malformed.value.coverage.reasons).toEqual(['malformed-symbol-omitted']);
    expect(malformed.value.coverage.inventory).toMatchObject({
      requested: true,
      complete: false,
      reasons: ['malformed-symbol-omitted'],
    });
    expect(malformed.value.coverage.evidence.requested).toBe(false);

    const span = await port.findBySpan('src/nested.ts', 2);
    expect(span.ok).toBe(true);
    if (!span.ok) return;
    expect(span.value.data).toHaveLength(500);
    expect(span.value.coverage.complete).toBe(false);
    expect(span.value.coverage.truncated).toBe(true);
    expect(span.value.coverage.reasons).toEqual(['span-candidate-cap']);
    expect(span.value.coverage.inventory.truncated).toBe(true);
  });

  it('refresh returns action + generation without throwing', async () => {
    const events: string[] = [];
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: PROJECT,
      adapters: stubAdapters(),
      languageAdapters: [],
      rebuild: () => Promise.resolve(ok(seededCatalog())),
      log: (event) => events.push(event),
    });
    const refreshed = await port.refresh({ forceRebuild: true });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.data.action).toBe('rebuilt');
    expect(refreshed.value.data.generation.identity.startsWith('g1:')).toBe(true);
    expect(refreshed.value.context.catalog.status).toBe('loaded');
    expect(events.filter((event) => event.startsWith('mcp.graph.refresh.'))).toEqual([]);
  });

  it('returns a rebuilt generation with partial freshness when post-build verification fails', async () => {
    const adapters: GraphAdapterRegistryReader = {
      size: 1,
      getAll: () => {
        throw new Error('private registry failure');
      },
      getById: () => undefined,
    };
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: PROJECT,
      adapters,
      languageAdapters: [],
      rebuild: () => Promise.resolve(ok(seededCatalog())),
    });
    const refreshed = await port.refresh({ forceRebuild: true });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.data.action).toBe('rebuilt');
    expect(refreshed.value.freshness).toMatchObject({
      fresh: false,
      verification: 'partial',
      reasonCode: 'verification-unavailable',
    });
  });

  it('marks an exact recorded graph pointer stale when source freshness cannot be verified', async () => {
    new CatalogRepo(store).replaceAll(seededCatalog());
    const adapters: GraphAdapterRegistryReader = {
      size: 1,
      getAll: () => {
        throw new Error('private registry failure');
      },
      getById: () => undefined,
    };
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: PROJECT,
      adapters,
      languageAdapters: [],
      rebuild: () => Promise.resolve(ok(seededCatalog())),
    });
    const catalog = seededCatalog();
    const identity = catalogGenerationKey({
      language: catalog.language,
      cacheKey: catalog.cacheKey,
      filesFingerprint: catalog.filesFingerprint ?? '',
      builtAt: catalog.builtAt,
    });

    const pointer = await port.contextPointerStatus({
      owner: 'graph',
      kind: 'graph',
      id: identity,
      schemaVersion: 3,
    });

    expect(pointer).toMatchObject({
      ok: true,
      value: {
        status: 'stale',
        reasonCodes: ['graph-generation-not-current', 'graph-freshness-verification-failed'],
      },
    });
  });

  it('auto-swaps when a newer catalog is persisted externally', async () => {
    new CatalogRepo(store).replaceAll(seededCatalog('2026-01-01T00:00:00.000Z'));
    const port = makePort(store);
    const first = await port.catalogStatus();
    expect(first.ok && first.value.context.catalog.builtAt).toBe('2026-01-01T00:00:00.000Z');
    if (!first.ok) return;
    const firstId = first.value.context.catalog.identity;

    new CatalogRepo(store).replaceAll(seededCatalog('2026-06-01T00:00:00.000Z'));
    const second = await port.catalogStatus();
    expect(second.ok && second.value.context.catalog.builtAt).toBe('2026-06-01T00:00:00.000Z');
    if (!second.ok) return;
    expect(second.value.context.catalog.identity).not.toBe(firstId);
    expect(second.value.context.catalog.generationSource).toBe('persisted-auto-swap');
  });

  it('search applies kind filter before limit and supports exact/qualified match', async () => {
    new CatalogRepo(store).replaceAll({
      ...seededCatalog(),
      functions: {
        save: [
          fnOcc({
            bodyHash: 'h-save',
            simpleName: 'save',
            filePath: 'src/a.ts',
            kind: 'function-declaration',
          }),
        ],
        saveBaseline: [
          fnOcc({
            bodyHash: 'h-sb',
            simpleName: 'saveBaseline',
            qualifiedName: 'fit.saveBaseline',
            filePath: 'src/b.ts',
            kind: 'method',
          }),
        ],
        Save: [
          fnOcc({
            bodyHash: 'h-Save',
            simpleName: 'Save',
            filePath: 'src/c.ts',
            kind: 'function-declaration',
          }),
        ],
      },
    });
    const port = makePort(store);

    // With limit=1 and kind=method, post-limit filtering would miss the method.
    const filtered = await port.searchSymbols('save', {
      match: 'substring',
      limit: 1,
      filter: { kinds: ['method'], sourceScope: 'all', generated: 'include' },
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.data.detail).toBe('nodes');
    expect(filtered.value.data.symbols).toHaveLength(1);
    expect(filtered.value.data.symbols[0]?.kind).toBe('method');
    expect(filtered.value.filter?.kinds).toEqual(['method']);

    const exact = await port.searchSymbols('save', {
      match: 'exact',
      filter: { sourceScope: 'all', generated: 'include' },
    });
    expect(exact.ok && exact.value.data.symbols.every((s) => s.simpleName === 'save')).toBe(true);

    const qualified = await port.searchSymbols('fit.saveBaseline', {
      match: 'qualified',
      filter: { sourceScope: 'all', generated: 'include' },
    });
    expect(qualified.ok && qualified.value.data.symbols).toHaveLength(1);
    expect(qualified.ok && qualified.value.data.symbols[0]?.symbolId).toBeTruthy();

    const clamped = await port.searchSymbols('save', { limit: 10_000 });
    expect(clamped.ok && clamped.value.page?.limit).toBe(500);

    // Omitted limit defaults to DEFAULT_IDENTITY_SEARCH_LIMIT = 20.
    const omitted = await port.searchSymbols('save');
    expect(omitted.ok && omitted.value.page?.limit).toBe(20);

    for (const limit of [1, 19, 20, 21, 500] as const) {
      const page = await port.searchSymbols('save', { limit });
      expect(page.ok && page.value.page?.limit, `limit=${String(limit)}`).toBe(limit);
    }
  });

  it('search_symbols projects exclusive summary/groups/nodes and binds detail into cursors', async () => {
    const functions: Record<string, FunctionOccurrence[]> = {};
    for (let index = 0; index < 5; index++) {
      functions[`fn${String(index)}`] = [
        fnOcc({
          bodyHash: `h-${String(index)}`,
          simpleName: `shared${String(index)}`,
          filePath: index % 2 === 0 ? 'src/a.ts' : 'src/b.ts',
          package: index % 2 === 0 ? 'pkg-a' : 'pkg-b',
          line: index + 1,
          column: 0,
        }),
      ];
    }
    new CatalogRepo(store).replaceAll({ ...seededCatalog(), functions });
    const port = makePort(store);

    const summary = await port.searchSymbols('shared', { detail: 'summary' });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.data).toEqual({
      detail: 'summary',
      symbols: [],
      totalMatches: 5,
    });
    expect(summary.value.groups).toBeUndefined();
    expect(summary.value.coverage.inventory.requested).toBe(true);
    expect(summary.value.coverage.grouping.requested).toBe(false);
    expect(summary.value.coverage.evidence.requested).toBe(false);

    const groups = await port.searchSymbols('shared', {
      detail: 'groups',
      groupBy: 'package',
      limit: 10,
    });
    expect(groups.ok).toBe(true);
    if (!groups.ok) return;
    expect(groups.value.data.detail).toBe('groups');
    expect(groups.value.data.symbols).toEqual([]);
    expect(groups.value.data.totalMatches).toBe(5);
    expect(groups.value.groups?.map((g) => g.key).sort()).toEqual(['pkg-a', 'pkg-b']);
    expect(groups.value.coverage.grouping.requested).toBe(true);
    expect(groups.value.coverage.projection.requested).toBe(true);

    const nodes = await port.searchSymbols('shared', { detail: 'nodes', limit: 2 });
    expect(nodes.ok).toBe(true);
    if (!nodes.ok) return;
    expect(nodes.value.data.detail).toBe('nodes');
    expect(nodes.value.data.symbols).toHaveLength(2);
    expect(nodes.value.data.totalMatches).toBe(5);
    expect(nodes.value.groups).toBeUndefined();
    expect(nodes.value.page?.nextCursor).toBeDefined();
    expect(nodes.value.data.symbols[0]?.symbolId).toMatch(/:/);

    // Cursor from nodes is invalid for groups (detail bound into digest).
    const mismatch = await port.searchSymbols('shared', {
      detail: 'groups',
      groupBy: 'package',
      cursor: nodes.value.page?.nextCursor,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('cursor-query-mismatch');

    // groups without groupBy rejected; nodes with groupBy rejected.
    const groupsNeedMode = await port.searchSymbols('shared', { detail: 'groups' });
    expect(groupsNeedMode.ok).toBe(false);
    if (!groupsNeedMode.ok) expect(groupsNeedMode.error.code).toBe('invalid-query');

    const nodesNoGroup = await port.searchSymbols('shared', {
      detail: 'nodes',
      groupBy: 'package',
    });
    expect(nodesNoGroup.ok).toBe(false);
    if (!nodesNoGroup.ok) expect(nodesNoGroup.error.code).toBe('invalid-query');

    // Exact empty catalog / exact missing match still returns usable shape.
    const emptyExact = await port.searchSymbols('no-such-symbol', {
      match: 'exact',
      detail: 'nodes',
    });
    expect(emptyExact.ok).toBe(true);
    if (!emptyExact.ok) return;
    expect(emptyExact.value.data).toEqual({
      detail: 'nodes',
      symbols: [],
      totalMatches: 0,
    });
  });

  it('architecture returns labelled metrics and production defaults', async () => {
    new CatalogRepo(store).replaceAll(seededCatalog());
    const port = makePort(store);
    const arch = await port.architectureSummary({ limit: 10 });
    expect(arch.ok).toBe(true);
    if (!arch.ok) return;
    expect(arch.value.data.occurrenceCount.nodeIdentity).toBe('occurrence');
    expect(arch.value.data.uniqueBodyCount.nodeIdentity).toBe('body-hash');
    expect(arch.value.data.callEvidence.edgeKind).toBe('call');
    expect(arch.value.filter?.sourceScope).toBe('production');
    expect(arch.value.filter?.generated).toBe('exclude');
    // Default sections=['metrics'] omit ranked families (P2 Phase 2.5).
    expect(arch.value.data.includedSections).toEqual(['metrics']);
    expect(arch.value.data.packageEdges).toBeUndefined();
    expect(arch.value.data.hotspots).toBeUndefined();

    const full = await port.architectureSummary({
      limit: 10,
      sections: ['metrics', 'packageEdges', 'hotspots'],
      topN: 20,
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(Array.isArray(full.value.data.packageEdges)).toBe(true);
    expect(Array.isArray(full.value.data.hotspots)).toBe(true);
    expect(full.value.data.packageEdgesSummary?.selectedCount).toBeLessThanOrEqual(20);
  });

  it('reclassifies configured support paths to test scope end-to-end (P2 Phase 1)', async () => {
    // A non-test production file plus a support file the adapter did NOT flag as
    // a test (inTestFile false). Audit globs should move the support file to test
    // scope so it drops out of the production architecture summary.
    const roleCatalog: Catalog = {
      ...seededCatalog(),
      functions: {
        prod: [
          fnOcc({
            bodyHash: 'h-prod',
            simpleName: 'prodFn',
            filePath: 'packages/core/src/index.ts',
            package: 'pkg-core',
          }),
        ],
        support: [
          fnOcc({
            bodyHash: 'h-support',
            simpleName: 'supportFn',
            filePath: 'packages/test-support/src/harness.ts',
            package: 'pkg-test-support',
            inTestFile: false,
          }),
        ],
      },
    };
    new CatalogRepo(store).replaceAll(roleCatalog);

    // Control: no audit globs → the support file stays in production scope.
    const base = makePort(store);
    const baseArch = await base.architectureSummary({ limit: 10 });
    expect(baseArch.ok).toBe(true);
    if (!baseArch.ok) return;
    expect(baseArch.value.data.occurrenceCount.value).toBe(2);
    expect(baseArch.value.filter?.sourceRoles).toBeUndefined();

    // Audited: the support glob reclassifies the support file as a test source,
    // excluding it from the production summary, and the plain policy is echoed.
    const audited = new SqliteGraphReadPort({
      store,
      projectRoot: PROJECT,
      adapters: stubAdapters(),
      languageAdapters: [],
      rebuild: () => Promise.resolve(ok(roleCatalog)),
      config: { auditTestSourceGlobs: ['packages/test-support/**'] },
    });
    const arch = await audited.architectureSummary({ limit: 10 });
    expect(arch.ok).toBe(true);
    if (!arch.ok) return;
    expect(arch.value.data.occurrenceCount.value).toBe(1);
    expect(arch.value.filter?.sourceRoles).toEqual({
      testGlobs: ['packages/test-support/**'],
      mode: 'audit-test-globs-v1',
    });
  });

  it('uses configured test roots for static test selection', async () => {
    const source = seededCatalog();
    const customTest = fnOcc({
      bodyHash: 'h-custom-test',
      simpleName: 'customTest',
      filePath: 'quality/custom-check.ts',
      inTestFile: false,
      calls: [
        {
          to: ['h-target'],
          line: 2,
          column: 1,
          resolution: 'static',
          confidence: 'high',
          text: 'target()',
        },
      ],
    });
    const roleCatalog: Catalog = {
      ...source,
      functions: { target: source.functions.target, custom: [customTest] },
    };
    new CatalogRepo(store).replaceAll(roleCatalog);
    const port = new SqliteGraphReadPort({
      store,
      projectRoot: PROJECT,
      adapters: stubAdapters(),
      languageAdapters: [],
      rebuild: () => Promise.resolve(ok(roleCatalog)),
      config: { auditTestSourceGlobs: ['quality/**'] },
    });
    const result = await port.selectTests(['src/target.ts'], INVENTORY);
    expect(result).toMatchObject({
      ok: true,
      value: {
        data: {
          tests: expect.arrayContaining([
            expect.objectContaining({ path: 'quality/custom-check.ts' }),
          ]),
        },
      },
    });
  });

  it('deadCode filters before pagination and rejects stale cursors', async () => {
    new CatalogRepo(store).replaceAll(seededCatalog());
    const port = makePort(store);
    const first = await port.deadCode({
      limit: 1,
      detail: 'nodes',
      filter: { sourceScope: 'all', generated: 'include' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.data.rows.length).toBeLessThanOrEqual(1);
    if (first.value.page?.nextCursor !== undefined) {
      const stale = await port.deadCode({
        limit: 1,
        detail: 'nodes',
        cursor: first.value.page.nextCursor,
        filter: { sourceScope: 'production', generated: 'exclude' },
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe('cursor-query-mismatch');
    }
  });

  it('pages one labelled package dependency stream and groups the full filtered set', async () => {
    new CatalogRepo(store).replaceAll(packageCatalog());
    const port = makePort(store);
    const first = await port.packageDependencies({
      edgeKind: 'combined',
      direction: 'both',
      package: 'pkg-a',
      limit: 1,
      groupBy: 'package',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.data.calls.length + first.value.data.imports.length).toBe(1);
    expect(first.value.page?.nextCursor).toBeDefined();
    expect((first.value.groups?.length ?? 0) > 1).toBe(true);
    expect(first.value.coverage.truncated).toBe(false);

    const seen = new Set([
      ...first.value.data.calls.map((row) => `call:${row.fromPackage}:${row.toPackage}`),
      ...first.value.data.imports.map((row) => `import:${row.fromPackage}:${row.target}`),
    ]);
    const cursor = first.value.page?.nextCursor;
    expect(cursor).toBeDefined();
    if (cursor === undefined) return;
    const second = await port.packageDependencies({
      edgeKind: 'combined',
      direction: 'both',
      package: 'pkg-a',
      limit: 1,
      groupBy: 'package',
      cursor,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondKeys = [
      ...second.value.data.calls.map((row) => `call:${row.fromPackage}:${row.toPackage}`),
      ...second.value.data.imports.map((row) => `import:${row.fromPackage}:${row.target}`),
    ];
    expect(secondKeys.every((key) => !seen.has(key))).toBe(true);
  });

  it('applies both-direction package selection before the package-edge cap', async () => {
    const functions: Record<string, FunctionOccurrence[]> = {};
    for (let index = 0; index < 10_001; index++) {
      const suffix = String(index).padStart(5, '0');
      functions[`caller${suffix}`] = [
        fnOcc({
          bodyHash: `caller-${suffix}`,
          simpleName: `caller${suffix}`,
          filePath: `packages/a-${suffix}/caller.ts`,
          package: `a-${suffix}`,
          calls: [
            {
              to: [`target-${suffix}`],
              line: 2,
              column: 0,
              resolution: 'static',
              confidence: 'high',
              text: 'target()',
            },
          ],
        }),
      ];
      functions[`target${suffix}`] = [
        fnOcc({
          bodyHash: `target-${suffix}`,
          simpleName: `target${suffix}`,
          filePath: `packages/b-${suffix}/target.ts`,
          package: `b-${suffix}`,
        }),
      ];
    }
    functions.focus = [
      fnOcc({
        bodyHash: 'focus',
        simpleName: 'focus',
        filePath: 'packages/z-focus/focus.ts',
        package: 'z-focus',
        calls: [
          {
            to: ['focus-target'],
            line: 2,
            column: 0,
            resolution: 'static',
            confidence: 'high',
            text: 'focusTarget()',
          },
        ],
      }),
    ];
    functions.focusTarget = [
      fnOcc({
        bodyHash: 'focus-target',
        simpleName: 'focusTarget',
        filePath: 'packages/z-target/target.ts',
        package: 'z-target',
      }),
    ];
    new CatalogRepo(store).replaceAll({ ...seededCatalog(), functions });
    const result = await makePort(store).packageDependencies({
      package: 'z-focus',
      direction: 'both',
      edgeKind: 'call',
      limit: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.calls).toEqual([
      expect.objectContaining({
        fromPackage: 'z-focus',
        toPackage: 'z-target',
      }),
    ]);
  });

  it('returns concrete why-depends evidence and deterministic package cycles', async () => {
    new CatalogRepo(store).replaceAll(packageCatalog());
    const port = makePort(store);
    const first = await port.whyDepends({
      fromPackage: 'pkg-a',
      toPackage: 'pkg-b',
      edgeKind: 'combined',
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.data.totalMatchingEvidence).toBe(2);
    expect(first.value.data.calls.length + first.value.data.imports.length).toBe(1);
    expect(first.value.page?.nextCursor).toBeDefined();
    const call = first.value.data.calls[0];
    if (call !== undefined) {
      expect(call).toMatchObject({
        kind: 'call',
        confidence: 'high',
        from: { package: 'pkg-a' },
        to: { package: 'pkg-b' },
      });
    }

    const cycles = await port.packageCycles({
      edgeKind: 'combined',
      limit: 10,
    });
    expect(cycles.ok).toBe(true);
    if (!cycles.ok) return;
    expect(cycles.value.data.components).toEqual([
      expect.objectContaining({
        packages: ['pkg-a', 'pkg-b'],
        proofEdges: expect.arrayContaining([
          expect.objectContaining({ from: 'pkg-a', to: 'pkg-b' }),
          expect.objectContaining({ from: 'pkg-b', to: 'pkg-a' }),
        ]),
      }),
    ]);
  });

  it('pages duplicate-site semantic call proofs without repeating an anchor', async () => {
    const catalog = packageCatalog();
    const nodeA = catalog.functions.nodeA?.[0];
    const exact = nodeA?.calls[0];
    if (nodeA === undefined || exact === undefined) throw new Error('package fixture incomplete');
    new CatalogRepo(store).replaceAll({
      ...catalog,
      functions: {
        ...catalog.functions,
        nodeA: [
          {
            ...nodeA,
            calls: [exact, { ...exact }, { ...exact, confidence: 'medium' }],
          },
        ],
      },
    });
    const port = makePort(store);
    const first = await port.whyDepends({
      fromPackage: 'pkg-a',
      toPackage: 'pkg-b',
      edgeKind: 'call',
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.page?.nextCursor === undefined) return;
    expect(first.value.data.totalMatchingEvidence).toBe(3);
    expect(first.value.data.calls).toHaveLength(1);

    const second = await port.whyDepends({
      fromPackage: 'pkg-a',
      toPackage: 'pkg-b',
      edgeKind: 'call',
      limit: 1,
      cursor: first.value.page.nextCursor,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.data.calls).toHaveLength(1);
    expect(second.value.data.calls[0]?.confidence).not.toBe(first.value.data.calls[0]?.confidence);
    expect(second.value.page?.nextCursor).toBeUndefined();
  });

  it('binds package cursors to query and catalog generation', async () => {
    new CatalogRepo(store).replaceAll(packageCatalog());
    const port = makePort(store);
    const first = await port.packageDependencies({
      edgeKind: 'combined',
      limit: 1,
    });
    expect(first.ok).toBe(true);
    if (!first.ok || first.value.page?.nextCursor === undefined) return;

    const decoded = decodeCursor(first.value.page.nextCursor);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const wrongProject = await port.packageDependencies({
      edgeKind: 'combined',
      limit: 1,
      cursor: encodeCursor({ ...decoded.value, projectKey: 'f'.repeat(24) }),
    });
    expect(wrongProject.ok).toBe(false);
    if (!wrongProject.ok) expect(wrongProject.error.code).toBe('cursor-project-mismatch');

    const queryMismatch = await port.packageDependencies({
      edgeKind: 'import',
      limit: 1,
      cursor: first.value.page.nextCursor,
    });
    expect(queryMismatch.ok).toBe(false);
    if (!queryMismatch.ok) expect(queryMismatch.error.code).toBe('cursor-query-mismatch');

    new CatalogRepo(store).replaceAll(packageCatalog('2026-06-01T00:00:00.000Z'));
    const stale = await port.packageDependencies({
      edgeKind: 'combined',
      limit: 1,
      cursor: first.value.page.nextCursor,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('cursor-stale');
  });

  it('continues architecture package/hotspot families independently without repeats', async () => {
    new CatalogRepo(store).replaceAll(packageCatalog());
    const port = makePort(store);
    const edgeKeys = new Set<string>();
    const hotspotKeys = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await port.architectureSummary({
        limit: 1,
        sections: ['metrics', 'packageEdges', 'hotspots'],
        topN: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const edge of result.value.data.packageEdges ?? []) {
        const key = `${edge.fromPackage}:${edge.toPackage}`;
        expect(edgeKeys.has(key)).toBe(false);
        edgeKeys.add(key);
      }
      for (const hotspot of result.value.data.hotspots ?? []) {
        expect(hotspotKeys.has(hotspot.symbol.symbolId)).toBe(false);
        hotspotKeys.add(hotspot.symbol.symbolId);
      }
      cursor = result.value.page?.nextCursor;
      if (cursor === undefined) break;
    }
    expect(edgeKeys.size).toBeGreaterThan(1);
    expect(hotspotKeys.size).toBeGreaterThan(1);
    expect(cursor).toBeUndefined();
  });

  it('searchDeclarations / referencesTo page exclusive detail and bind cursors (P2 Phase 3)', async () => {
    const declarationId =
      'd1|pkg|src/types.ts|interface|AuditShape|0000000000000001|0000000000000000';
    // Distinct builtAt so catalog identity differs from the pre-feature seed and
    // the SQLite generation controller auto-swaps (identity is not content-deep).
    const semanticCatalog: Catalog = {
      ...seededCatalog('2026-07-11T12:00:00.000Z'),
      engineMode: 'exact',
      resolutionMode: 'exact',
      semanticFacts: {
        referenceScope: 'cross-file',
        declarations: [
          {
            declarationId,
            name: 'AuditShape',
            qualifiedName: 'src/types.AuditShape',
            kind: 'interface',
            package: 'pkg',
            filePath: 'src/types.ts',
            line: 1,
            column: 0,
            endLine: 5,
            endColumn: 1,
            visibility: 'exported',
            exportRole: 'named-export',
            inTestFile: false,
            definedInGenerated: false,
          },
          {
            declarationId:
              'd1|pkg|src/types.ts|type-alias|AuditAlias|0000000000000002|0000000000000000',
            name: 'AuditAlias',
            qualifiedName: 'src/types.AuditAlias',
            kind: 'type-alias',
            package: 'pkg',
            filePath: 'src/types.ts',
            line: 7,
            column: 0,
            endLine: 7,
            endColumn: 30,
            visibility: 'exported',
            exportRole: 'named-export',
            inTestFile: false,
            definedInGenerated: false,
          },
        ],
        references: [
          {
            referenceId: 'r1|src/use.ts|type|0000000000000010|0000000000000000|d1',
            kind: 'type',
            filePath: 'src/use.ts',
            line: 2,
            column: 0,
            endLine: 2,
            endColumn: 10,
            package: 'pkg',
            targetDeclarationId: declarationId,
            targetPackage: 'pkg',
            targetName: 'AuditShape',
            targetKind: 'interface',
            basis: 'compiler-declaration',
            confidence: 'high',
            inTestFile: false,
            definedInGenerated: false,
          },
          {
            referenceId: 'r1|src/other.ts|type|0000000000000011|0000000000000000|d1',
            kind: 'type',
            filePath: 'src/other.ts',
            line: 3,
            column: 0,
            endLine: 3,
            endColumn: 10,
            package: 'pkg-b',
            targetDeclarationId: declarationId,
            targetPackage: 'pkg',
            targetName: 'AuditShape',
            targetKind: 'interface',
            basis: 'compiler-declaration',
            confidence: 'high',
            inTestFile: false,
            definedInGenerated: false,
          },
        ],
        coverage: {
          status: 'complete',
          inspectedDeclarations: 2,
          emittedDeclarations: 2,
          omittedDeclarations: 0,
          inspectedReferences: 2,
          emittedReferences: 2,
          omittedReferences: 0,
          reasons: [],
        },
      },
    };
    // Absent plane: pre-feature catalogs report unsupported inventory honestly.
    new CatalogRepo(store).replaceAll(seededCatalog('2026-07-11T11:00:00.000Z'));
    const port = makePort(store);
    const unsupported = await port.searchDeclarations('AuditShape');
    expect(unsupported.ok).toBe(true);
    if (!unsupported.ok) return;
    expect(unsupported.value.data.declarations).toEqual([]);
    expect(unsupported.value.coverage.inventory.complete).toBe(false);
    expect(unsupported.value.coverage.inventory.reasons).toContain('semantic-facts-unsupported');

    // Externally persist a newer generation with the semantic plane; ordinary
    // reads auto-load it without a rebuild.
    new CatalogRepo(store).replaceAll(semanticCatalog);

    const summary = await port.searchDeclarations('Audit', { detail: 'summary' });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.data).toMatchObject({
      detail: 'summary',
      referenceScope: 'cross-file',
      declarations: [],
      totalMatches: 2,
    });
    expect(summary.value.context.catalog.generationSource).toBe('persisted-auto-swap');
    // Identity-search default page limit is 20 (not the unrelated 100-row default).
    const omittedLimit = await port.searchDeclarations('Audit');
    expect(omittedLimit.ok && omittedLimit.value.page?.limit).toBe(20);

    const nodes = await port.searchDeclarations('AuditShape', {
      match: 'exact',
      detail: 'nodes',
      kinds: ['interface'],
      limit: 20,
    });
    expect(nodes.ok).toBe(true);
    if (!nodes.ok) return;
    expect(nodes.value.data.declarations).toHaveLength(1);
    expect(nodes.value.data.declarations[0]?.declarationId).toBe(declarationId);
    // Declaration IDs must never look like callable symbolIds (file:line:col).
    expect(nodes.value.data.declarations[0]?.declarationId.includes(':')).toBe(false);

    const groups = await port.searchDeclarations('Audit', {
      detail: 'groups',
      groupBy: 'package',
    });
    expect(groups.ok).toBe(true);
    if (!groups.ok) return;
    expect(groups.value.data.detail).toBe('groups');
    expect(groups.value.data.declarations).toEqual([]);
    expect(groups.value.groups?.length).toBeGreaterThan(0);

    // Detail/groupBy are bound into the cursor digest (nodes ↔ groups mismatch).
    // Summary intentionally ignores cursors (counts only); mismatch is enforced
    // on paged exclusive projections.
    const paged = await port.searchDeclarations('Audit', { detail: 'nodes', limit: 1 });
    expect(paged.ok && paged.value.page?.nextCursor).toBeDefined();
    if (!paged.ok || paged.value.page?.nextCursor === undefined) return;
    const mismatch = await port.searchDeclarations('Audit', {
      detail: 'groups',
      groupBy: 'package',
      cursor: paged.value.page.nextCursor,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe('cursor-query-mismatch');

    // references_to defaults to summary and never invents same-file sites.
    const refsSummary = await port.referencesTo(declarationId, { detail: 'summary' });
    expect(refsSummary.ok).toBe(true);
    if (!refsSummary.ok) return;
    expect(refsSummary.value.data).toMatchObject({
      detail: 'summary',
      referenceScope: 'cross-file',
      declarationId,
      references: [],
      totalMatches: 2,
    });

    const refsNodes = await port.referencesTo(declarationId, { detail: 'nodes', limit: 10 });
    expect(refsNodes.ok).toBe(true);
    if (!refsNodes.ok) return;
    expect(refsNodes.value.data.references).toHaveLength(2);
    expect(refsNodes.value.data.references.every((r) => r.filePath !== 'src/types.ts')).toBe(true);

    const missing = await port.referencesTo('d1|missing');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('not-found');

    // Batch static-handler bridge over one generation (no N+1 freshness flights).
    const bridge = await port.resolveStaticHandlerDeclarations('w1:test-snapshot', [
      {
        package: 'pkg',
        path: 'src/types.ts',
        declaration: 'AuditShape',
        owner: 'host',
      },
      {
        package: 'pkg',
        path: 'src/types.ts',
        declaration: 'NoSuchDecl',
        owner: 'host',
      },
    ]);
    expect(bridge.ok).toBe(true);
    if (!bridge.ok) return;
    expect(bridge.value.catalogStatus).toBe('loaded');
    expect(bridge.value.outcomes).toHaveLength(2);
    expect(bridge.value.outcomes[0]?.status).toBe('resolved');
    expect(bridge.value.outcomes[0]?.declarationId).toBe(declarationId);
    expect(bridge.value.outcomes[0]?.claimProvenance).toBe('author-declared');
    expect(bridge.value.outcomes[1]?.status).toBe('not-found');

    // Cache hit path: same w1:+g1: reuses completed outcomes.
    const again = await port.resolveStaticHandlerDeclarations('w1:test-snapshot', [
      {
        package: 'pkg',
        path: 'src/types.ts',
        declaration: 'AuditShape',
        owner: 'host',
      },
    ]);
    expect(again.ok && again.value.outcomes[0]?.status).toBe('resolved');
  });
});
