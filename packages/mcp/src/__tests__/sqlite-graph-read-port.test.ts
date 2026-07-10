/**
 * SqliteGraphReadPort against a real in-memory DataStore (Phase 1 cutover).
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { CatalogRepo } from '@opensip-cli/graph/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
      target: [fnOcc({ bodyHash: 'h-target', simpleName: 'target', filePath: 'src/target.ts' })],
      lonely1: [fnOcc({ bodyHash: 'h-l1', simpleName: 'lonely1', filePath: 'src/l1.ts' })],
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
    rebuild: () => Promise.resolve(ok(seededCatalog())),
  });
}

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

  it('loads a seeded catalog and serves search/traverse with context', async () => {
    new CatalogRepo(store).replaceAll(seededCatalog());
    const port = makePort(store);

    const search = await port.searchSymbols('caller');
    expect(search.ok).toBe(true);
    if (!search.ok) return;
    expect(search.value.context.catalog.status).toBe('loaded');
    expect(search.value.context.catalog.identity?.startsWith('g1:')).toBe(true);
    expect(search.value.coverage).toBeDefined();
    expect(search.value.data.some((s) => s.simpleName === 'caller')).toBe(true);
    expect(search.value.data[0]?.package).toBe('pkg');

    const start = search.value.data[0].symbolId;
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

  it('refresh returns action + generation without throwing', async () => {
    const port = makePort(store);
    const refreshed = await port.refresh({ forceRebuild: true });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) return;
    expect(refreshed.value.data.action).toBe('rebuilt');
    expect(refreshed.value.data.generation.identity.startsWith('g1:')).toBe(true);
    expect(refreshed.value.context.catalog.status).toBe('loaded');
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
    expect(filtered.value.data).toHaveLength(1);
    expect(filtered.value.data[0]?.kind).toBe('method');
    expect(filtered.value.filter?.kinds).toEqual(['method']);

    const exact = await port.searchSymbols('save', {
      match: 'exact',
      filter: { sourceScope: 'all', generated: 'include' },
    });
    expect(exact.ok && exact.value.data.every((s) => s.simpleName === 'save')).toBe(true);

    const qualified = await port.searchSymbols('fit.saveBaseline', {
      match: 'qualified',
      filter: { sourceScope: 'all', generated: 'include' },
    });
    expect(qualified.ok && qualified.value.data).toHaveLength(1);
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
    expect(Array.isArray(arch.value.data.packageEdges)).toBe(true);
    expect(Array.isArray(arch.value.data.hotspots)).toBe(true);
  });

  it('deadCode filters before pagination and rejects stale cursors', async () => {
    new CatalogRepo(store).replaceAll(seededCatalog());
    const port = makePort(store);
    const first = await port.deadCode({
      limit: 1,
      filter: { sourceScope: 'all', generated: 'include' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.data.length).toBeLessThanOrEqual(1);
    if (first.value.page?.nextCursor !== undefined) {
      const stale = await port.deadCode({
        limit: 1,
        cursor: first.value.page.nextCursor,
        filter: { sourceScope: 'production', generated: 'exclude' },
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe('cursor-query-mismatch');
    }
  });
});
