import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stampEngineVersion } from '../cache/engine-version.js';
import { computeFilesFingerprint } from '../cache/invalidate.js';
import { buildShardedCatalogCacheKey } from '../cache/sharded-cache-key.js';
import { resolveDefaultEngineShards } from '../cli/orchestrate/engine-shard-policy.js';
import {
  isSafeAdapterDescriptor,
  verifyCatalogInputs,
  type GraphAdapterRegistryReader,
} from '../read/index.js';

import type { GraphLanguageAdapter } from '../lang-adapter/types.js';
import type { Catalog } from '../types.js';
import type { LanguageAdapter } from '@opensip-cli/core';

const NO_LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [];

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-catalog-freshness-'));
  temporaryRoots.push(root);
  return root;
}

function stubAdapter(id: string, files: readonly string[] = []): GraphLanguageAdapter {
  return {
    id,
    fileExtensions: [`.${id.slice(0, 2)}`],
    displayName: id,
    discoverFiles: () => ({
      projectDirAbs: '/proj',
      files: [...files],
    }),
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
    cacheKey: () => `${id}-v1`,
  };
}

function registryOf(...adapters: GraphLanguageAdapter[]): GraphAdapterRegistryReader {
  const map = new Map(adapters.map((a) => [a.id, a]));
  return {
    get size() {
      return map.size;
    },
    getAll: () => [...map.entries()].map(([id, adapter]) => ({ id, adapter })),
    getById: (id) => {
      const adapter = map.get(id);
      return adapter === undefined ? undefined : { adapter };
    },
  };
}

function workspaceLanguageAdapters(
  _root: string,
  shardA: string,
  shardB: string,
): readonly LanguageAdapter[] {
  return [
    {
      id: 'typescript',
      fileExtensions: ['.ts'],
      parse: () => null,
      stripStrings: (content) => content,
      stripComments: (content) => content,
      discoverWorkspaceUnits: () =>
        Promise.resolve([
          {
            id: 'a',
            rootDir: shardA,
            configPath: join(shardA, 'tsconfig.json'),
          },
          {
            id: 'b',
            rootDir: shardB,
            configPath: join(shardB, 'tsconfig.json'),
          },
        ]),
    },
  ];
}

function catalog(partial: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-09T00:00:00.000Z',
    cacheKey: 'ts-v1',
    filesFingerprint: '0',
    functions: {},
    ...partial,
  };
}

describe('isSafeAdapterDescriptor', () => {
  it('accepts a well-formed adapter and rejects hostile ones', () => {
    expect(isSafeAdapterDescriptor(stubAdapter('typescript'))).toBe(true);
    expect(
      isSafeAdapterDescriptor({
        ...stubAdapter('typescript'),
        id: 'a'.repeat(100),
      }),
    ).toBe(false);
    expect(
      isSafeAdapterDescriptor({
        ...stubAdapter('typescript'),
        displayName: 'Type\u0085Script',
      }),
    ).toBe(false);
    expect(
      isSafeAdapterDescriptor({
        ...stubAdapter('typescript'),
        fileExtensions: Array.from({ length: 40 }, () => '.ts'),
      }),
    ).toBe(false);
  });
});

describe('buildShardedCatalogCacheKey', () => {
  it('binds cache keys to shard anchors without delimiter collisions', () => {
    const original = [
      { shardId: 'a|b', rootDir: 'packages/a', cacheKey: 'key-a' },
      { shardId: 'c', rootDir: 'packages/c|d', cacheKey: 'key-c' },
    ];
    const swapped = [
      { ...original[0], cacheKey: 'key-c' },
      { ...original[1], cacheKey: 'key-a' },
    ];
    const delimiterVariant = [
      { shardId: 'a', rootDir: 'b|packages/a', cacheKey: 'key-a' },
      original[1],
    ];
    expect(buildShardedCatalogCacheKey(original)).not.toBe(buildShardedCatalogCacheKey(swapped));
    expect(buildShardedCatalogCacheKey(original)).not.toBe(
      buildShardedCatalogCacheKey(delimiterVariant),
    );
  });
});

describe('verifyCatalogInputs', () => {
  it('returns partial when provenance is absent', async () => {
    const result = await verifyCatalogInputs({
      projectRoot: '/proj',
      catalog: catalog(),
      adapters: registryOf(stubAdapter('typescript')),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verification).toBe('partial');
    expect(result.value.fresh).toBe(false);
    expect(result.value.reasonCode).toBe('verification-unavailable');
  });

  it('detects selection drift when a different adapter is selected', async () => {
    const result = await verifyCatalogInputs({
      projectRoot: '/proj',
      catalog: catalog({
        language: 'typescript',
        adapterSelection: {
          mode: 'forced',
          requestedId: 'typescript',
          selectedId: 'typescript',
        },
        engineMode: 'exact',
      }),
      adapters: registryOf(stubAdapter('python')),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });
    // Forced request for typescript with only python registered → selection error.
    expect(result.ok).toBe(false);
  });

  it('detects engine-mode provenance drift before trusting cache inputs', async () => {
    const result = await verifyCatalogInputs({
      projectRoot: '/proj',
      catalog: catalog({
        cacheKey: stampEngineVersion('typescript-v1', 'sharded'),
        adapterSelection: {
          mode: 'forced',
          requestedId: 'typescript',
          selectedId: 'typescript',
        },
        engineMode: 'exact',
      }),
      adapters: registryOf(stubAdapter('typescript')),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        fresh: false,
        reasonCode: 'engine-mode-changed',
      }),
    });
  });

  it('verifies exact cache and file inputs completely', async () => {
    const root = temporaryProject();
    const file = join(root, 'src', 'a.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'export const a = 1;\n');
    const adapter = {
      ...stubAdapter('typescript', [file]),
      discoverFiles: () => ({ projectDirAbs: root, files: [file] }),
      cacheKey: () => 'typescript-v1',
    };

    const result = await verifyCatalogInputs({
      projectRoot: root,
      catalog: catalog({
        cacheKey: stampEngineVersion('typescript-v1', 'exact'),
        filesFingerprint: computeFilesFingerprint([file]),
        adapterSelection: {
          mode: 'forced',
          requestedId: 'typescript',
          selectedId: 'typescript',
        },
        engineMode: 'exact',
      }),
      adapters: registryOf(adapter),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ fresh: true, verification: 'complete' }),
    });
  });

  it('rejects a discovery root that is a parent of the configured project', async () => {
    const root = temporaryProject();
    const adapter = {
      ...stubAdapter('typescript'),
      discoverFiles: () => ({ projectDirAbs: dirname(root), files: [] }),
    };
    const result = await verifyCatalogInputs({
      projectRoot: root,
      catalog: catalog({
        cacheKey: stampEngineVersion('typescript-v1', 'exact'),
        filesFingerprint: '0',
        adapterSelection: {
          mode: 'forced',
          requestedId: 'typescript',
          selectedId: 'typescript',
        },
        engineMode: 'exact',
      }),
      adapters: registryOf(adapter),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('GRAPH.READ.VERIFY_DISCOVERY');
  });

  it('rejects a discovered symlink inside the project that resolves outside it', async () => {
    const root = temporaryProject();
    const outside = temporaryProject();
    const outsideFile = join(outside, 'secret.ts');
    const linkedFile = join(root, 'linked.ts');
    writeFileSync(outsideFile, 'export const secret = true;\n');
    symlinkSync(outsideFile, linkedFile, 'file');
    const adapter = {
      ...stubAdapter('typescript'),
      discoverFiles: () => ({ projectDirAbs: root, files: [linkedFile] }),
    };
    const result = await verifyCatalogInputs({
      projectRoot: root,
      catalog: catalog({
        cacheKey: stampEngineVersion('typescript-v1', 'exact'),
        adapterSelection: {
          mode: 'forced',
          requestedId: 'typescript',
          selectedId: 'typescript',
        },
        engineMode: 'exact',
      }),
      adapters: registryOf(adapter),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('GRAPH.READ.VERIFY_DISCOVERY');
  });

  it('classifies added, modified, and deleted files without leaking absolute paths', async () => {
    const root = temporaryProject();
    const modified = join(root, 'src', 'modified.ts');
    const deleted = join(root, 'src', 'deleted.ts');
    const added = join(root, 'src', 'added.ts');
    mkdirSync(dirname(modified), { recursive: true });
    writeFileSync(modified, 'old');
    writeFileSync(deleted, 'delete me');
    const previous = computeFilesFingerprint([deleted, modified].sort());
    rmSync(deleted);
    writeFileSync(modified, 'new and larger');
    utimesSync(modified, new Date('2026-01-02'), new Date('2026-01-02'));
    writeFileSync(added, 'added');
    const files = [added, modified].sort();
    const adapter = {
      ...stubAdapter('typescript', files),
      discoverFiles: () => ({ projectDirAbs: root, files }),
      cacheKey: () => 'typescript-v1',
    };

    const result = await verifyCatalogInputs({
      projectRoot: root,
      catalog: catalog({
        cacheKey: stampEngineVersion('typescript-v1', 'exact'),
        filesFingerprint: previous,
        adapterSelection: {
          mode: 'forced',
          requestedId: 'typescript',
          selectedId: 'typescript',
        },
        engineMode: 'exact',
      }),
      adapters: registryOf(adapter),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changes).toEqual({
      added: 1,
      modified: 1,
      deleted: 1,
      sample: ['src/added.ts', 'src/deleted.ts', 'src/modified.ts'],
    });
    expect(result.value.changes?.sample.join('\n')).not.toContain(root);
  });

  it('reassembles sharded cache inputs and detects config drift', async () => {
    const root = temporaryProject();
    const shardA = join(root, 'packages', 'a');
    const shardB = join(root, 'packages', 'b');
    mkdirSync(shardA, { recursive: true });
    mkdirSync(shardB, { recursive: true });
    const configA = join(shardA, 'tsconfig.json');
    const configB = join(shardB, 'tsconfig.json');
    const fileA = join(shardA, 'a.ts');
    const excludedTestA = join(shardA, 'a.test.ts');
    const fileB = join(shardB, 'b.ts');
    writeFileSync(configA, 'config-a-v1');
    writeFileSync(configB, 'config-b-v1');
    writeFileSync(fileA, 'a');
    writeFileSync(excludedTestA, 'test excluded by package config');
    writeFileSync(fileB, 'b');
    const adapter = {
      ...stubAdapter('typescript'),
      discoverFiles: ({ cwd }: { cwd: string }) => {
        if (cwd === root) {
          return {
            projectDirAbs: root,
            files: [fileA, excludedTestA, fileB].sort(),
          };
        }
        return {
          projectDirAbs: cwd,
          configPathAbs: join(cwd, 'tsconfig.json'),
          files: [join(cwd, cwd === shardA ? 'a.ts' : 'b.ts')],
        };
      },
      cacheKey: ({ configPathAbs }: { configPathAbs?: string }) =>
        configPathAbs === undefined ? 'missing' : readFileSync(configPathAbs, 'utf8'),
    } as GraphLanguageAdapter;
    const fragmentKeys = [
      {
        shardId: 'a',
        rootDir: 'packages/a',
        configPath: 'packages/a/tsconfig.json',
        cacheKey: stampEngineVersion(readFileSync(configA, 'utf8'), 'sharded'),
      },
      {
        shardId: 'b',
        rootDir: 'packages/b',
        configPath: 'packages/b/tsconfig.json',
        cacheKey: stampEngineVersion(readFileSync(configB, 'utf8'), 'sharded'),
      },
    ];
    const shardedCatalog = catalog({
      cacheKey: buildShardedCatalogCacheKey(fragmentKeys),
      filesFingerprint: computeFilesFingerprint([fileA, excludedTestA, fileB].sort()),
      adapterSelection: {
        mode: 'forced',
        requestedId: 'typescript',
        selectedId: 'typescript',
      },
      engineMode: 'sharded',
      shardCacheInputs: [
        {
          shardId: 'a',
          rootDir: 'packages/a',
          configPath: 'packages/a/tsconfig.json',
        },
        {
          shardId: 'b',
          rootDir: 'packages/b',
          configPath: 'packages/b/tsconfig.json',
        },
      ],
    });

    const fresh = await verifyCatalogInputs({
      projectRoot: root,
      catalog: shardedCatalog,
      adapters: registryOf(adapter),
      languageAdapters: workspaceLanguageAdapters(root, shardA, shardB),
    });
    expect(fresh.ok && fresh.value.fresh).toBe(true);

    const forcedExactCatalog = catalog({
      cacheKey: stampEngineVersion('missing', 'exact'),
      filesFingerprint: computeFilesFingerprint([fileA, excludedTestA, fileB].sort()),
      adapterSelection: {
        mode: 'forced',
        requestedId: 'typescript',
        selectedId: 'typescript',
      },
      engineMode: 'exact',
    });
    const forcedExact = await verifyCatalogInputs({
      projectRoot: root,
      catalog: forcedExactCatalog,
      adapters: registryOf(adapter),
      languageAdapters: workspaceLanguageAdapters(root, shardA, shardB),
    });
    expect(forcedExact).toEqual({
      ok: true,
      value: expect.objectContaining({ fresh: true, verification: 'complete' }),
    });

    const changedWorkspacePlan = workspaceLanguageAdapters(root, shardA, shardB).map(
      (languageAdapter) => ({
        ...languageAdapter,
        discoverWorkspaceUnits: () =>
          Promise.resolve([
            { id: 'renamed-a', rootDir: shardA, configPath: configA },
            { id: 'b', rootDir: shardB, configPath: configB },
          ]),
      }),
    );
    const shardPlanDrift = await verifyCatalogInputs({
      projectRoot: root,
      catalog: shardedCatalog,
      adapters: registryOf(adapter),
      languageAdapters: changedWorkspacePlan,
    });
    expect(shardPlanDrift).toEqual({
      ok: true,
      value: expect.objectContaining({
        fresh: false,
        reasonCode: 'cache-key-changed',
      }),
    });

    writeFileSync(configB, 'config-b-v2');
    const stale = await verifyCatalogInputs({
      projectRoot: root,
      catalog: shardedCatalog,
      adapters: registryOf(adapter),
      languageAdapters: workspaceLanguageAdapters(root, shardA, shardB),
    });
    expect(stale).toEqual({
      ok: true,
      value: expect.objectContaining({
        fresh: false,
        reasonCode: 'cache-key-changed',
      }),
    });
  });

  it('detects a partition-strategy change that remains in sharded mode', async () => {
    const root = temporaryProject();
    const configPath = join(root, 'tsconfig.json');
    writeFileSync(configPath, '{}');
    const files = Array.from({ length: 2501 }, (_, index) =>
      join(root, 'src', `file-${String(index).padStart(4, '0')}.ts`),
    );
    const adapter = {
      ...stubAdapter('typescript'),
      discoverFiles: () => ({
        projectDirAbs: root,
        configPathAbs: configPath,
        files,
      }),
      cacheKey: () => 'stable',
    };
    const originalPolicy = await resolveDefaultEngineShards({
      projectRoot: root,
      languageAdapters: NO_LANGUAGE_ADAPTERS,
      graphAdapter: adapter,
      graphConfig: { partitionStrategy: 'hybrid' },
      forcedLanguage: false,
      failureMode: 'verification-error',
    });
    expect(originalPolicy.shards.length).toBeGreaterThan(1);
    const shardCacheInputs = originalPolicy.shards.map((shard) => ({
      shardId: shard.id,
      rootDir: '.',
      configPath: 'tsconfig.json',
    }));
    const value = catalog({
      cacheKey: buildShardedCatalogCacheKey(
        shardCacheInputs.map((shard) => ({ ...shard, cacheKey: 'stable' })),
      ),
      adapterSelection: { mode: 'auto', selectedId: 'typescript' },
      engineMode: 'sharded',
      shardCacheInputs,
    });
    const result = await verifyCatalogInputs({
      projectRoot: root,
      catalog: value,
      adapters: registryOf(adapter),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
      graphConfig: { partitionStrategy: 'file-count-chunks' },
    });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        fresh: false,
        reasonCode: 'cache-key-changed',
      }),
    });
  });

  it('rejects unsorted discovery and inconsistent registry snapshots', async () => {
    const root = temporaryProject();
    const first = join(root, 'a.ts');
    const second = join(root, 'b.ts');
    writeFileSync(first, 'a');
    writeFileSync(second, 'b');
    const adapter = {
      ...stubAdapter('typescript'),
      discoverFiles: () => ({ projectDirAbs: root, files: [second, first] }),
    };
    const inputCatalog = catalog({
      cacheKey: stampEngineVersion('typescript-v1', 'exact'),
      filesFingerprint: computeFilesFingerprint([first, second]),
      adapterSelection: {
        mode: 'forced',
        requestedId: 'typescript',
        selectedId: 'typescript',
      },
      engineMode: 'exact',
    });

    const unsorted = await verifyCatalogInputs({
      projectRoot: root,
      catalog: inputCatalog,
      adapters: registryOf(adapter),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });
    expect(unsorted.ok).toBe(false);

    const inconsistent = await verifyCatalogInputs({
      projectRoot: root,
      catalog: inputCatalog,
      adapters: { ...registryOf(adapter), size: 2 },
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });
    expect(inconsistent.ok).toBe(false);
    if (!inconsistent.ok) expect(inconsistent.error.code).toBe('GRAPH.READ.VERIFY_REGISTRY');
  });

  it('rejects C1 controls in adapter cache keys', async () => {
    const root = temporaryProject();
    const adapter = {
      ...stubAdapter('typescript'),
      discoverFiles: () => ({ projectDirAbs: root, files: [] }),
      cacheKey: () => 'bad\u0085key',
    };
    const result = await verifyCatalogInputs({
      projectRoot: root,
      catalog: catalog({
        cacheKey: stampEngineVersion('prior', 'exact'),
        adapterSelection: {
          mode: 'forced',
          requestedId: 'typescript',
          selectedId: 'typescript',
        },
        engineMode: 'exact',
      }),
      adapters: registryOf(adapter),
      languageAdapters: NO_LANGUAGE_ADAPTERS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('GRAPH.READ.VERIFY_CACHE_KEY');
  });

  it('fails closed when engine-policy discovery throws during verification', async () => {
    const root = temporaryProject();
    const adapter = {
      ...stubAdapter('typescript'),
      discoverFiles: () => ({ projectDirAbs: root, files: [] }),
    };
    const failingLanguageAdapter: LanguageAdapter = {
      id: 'typescript',
      fileExtensions: ['.ts'],
      parse: () => null,
      stripStrings: (content) => content,
      stripComments: (content) => content,
      discoverWorkspaceUnits: () => Promise.reject(new Error('private discovery failure')),
    };
    const result = await verifyCatalogInputs({
      projectRoot: root,
      catalog: catalog({
        cacheKey: stampEngineVersion('typescript-v1', 'sharded'),
        adapterSelection: {
          mode: 'forced',
          requestedId: 'typescript',
          selectedId: 'typescript',
        },
        engineMode: 'sharded',
        shardCacheInputs: [{ shardId: ':root', rootDir: '.' }],
      }),
      adapters: registryOf(adapter),
      languageAdapters: [failingLanguageAdapter],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'GRAPH.READ.VERIFY_FAILED',
        operation: 'catalog-generation',
        message: 'Catalog input verification failed due to infrastructure error',
      },
    });
  });
});
