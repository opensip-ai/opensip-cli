/**
 * Tests for the pipeline orchestrator (`runGraph`).
 *
 * The orchestrator wires a `GraphLanguageAdapter`'s discoverFiles /
 * parseProject / walkProject / resolveCallSites + index building +
 * rule evaluation into a single linear pipeline, with a cache-hit
 * fast-path and a Wave 4 incremental rebuild path. We drive it with a
 * synthetic adapter that returns deterministic catalog data so each
 * branch of `obtainCatalog` is reachable.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runWithScope, runWithScopeSync } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGraph } from '../../cli/orchestrate.js';
import { currentAdapterRegistry } from '../../lang-adapter/registry.js';
import { CatalogRepo } from '../../persistence/catalog-repo.js';
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  RuleHints,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type { FunctionOccurrence, Rule } from '../../types.js';

interface FakeAdapterInput {
  readonly id?: string;
  readonly cacheKey?: string;
  readonly projectDir: string;
  readonly occurrences?: Record<string, FunctionOccurrence[]>;
  readonly files?: readonly string[];
  readonly compilerOptions?: unknown;
  readonly configPathAbs?: string;
  readonly ruleHints?: RuleHints;
}

function fakeAdapter(input: FakeAdapterInput): GraphLanguageAdapter {
  const id = input.id ?? 'fake';
  const cacheKey = input.cacheKey ?? 'fake-key-1';
  const occurrences = input.occurrences ?? {};
  const files = input.files ?? [join(input.projectDir, 'src', 'a.ts')];
  return {
    id,
    fileExtensions: ['.ts'],
    displayName: id,
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: input.projectDir,
      files,
      configPathAbs: input.configPathAbs,
      compilerOptions: input.compilerOptions,
    }),
    parseProject: (): ParseOutput => ({
      project: { token: 'parsed' },
      parseErrors: [],
    }),
    walkProject: (): WalkOutput => ({
      occurrences,
      callSites: [],
      parseErrors: [],
    }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map(),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => cacheKey,
    ruleHints: input.ruleHints,
  };
}

function occurrence(over: Partial<FunctionOccurrence>): FunctionOccurrence {
  return {
    bodyHash: 'h1',
    bodySize: 100,
    simpleName: 'fn',
    qualifiedName: 'src/a.fn',
    filePath: 'src/a.ts',
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

describe('runGraph orchestrator', () => {
  let datastore: DataStore;
  let projectDir: string;
  let scope: ReturnType<typeof makeGraphTestScope>;

  beforeEach(() => {
    // Item 1: graph registries are per-RunScope.
    scope = makeGraphTestScope();
    datastore = DataStoreFactory.open({ backend: 'memory' });
    projectDir = mkdtempSync(join(tmpdir(), 'orch-proj-'));
  });

  afterEach(() => {
    runWithScopeSync(scope, () => currentAdapterRegistry().clear());
    datastore.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function inGraphScope<T>(fn: () => Promise<T>): Promise<T> {
    return runWithScope(scope, fn);
  }

  it('runs every pipeline stage end-to-end and emits a catalog with no signals', async () => {
    await inGraphScope(async () => {
      currentAdapterRegistry().register(
        fakeAdapter({
          projectDir,
          occurrences: {
            fn: [occurrence({ bodyHash: 'h1', simpleName: 'fn' })],
          },
        }),
      );
      const result = await runGraph({
        cwd: projectDir,
        noCache: true,
        rules: [],
      });
      expect(result.catalog).not.toBeNull();
      expect(result.catalog?.language).toBe('fake');
      expect(result.indexes).not.toBeNull();
      expect(result.signals).toEqual([]);
      expect(result.cacheHit).toBe(false);
      expect(result.resolutionStats).not.toBeNull();
    });
  });

  it('emits stage-start / stage-done progress events in canonical order', async () => {
    await inGraphScope(async () => {
      currentAdapterRegistry().register(fakeAdapter({ projectDir }));
      const events: string[] = [];
      await runGraph({
        cwd: projectDir,
        noCache: true,
        rules: [],
        onProgress: (e) => {
          events.push(`${e.type}:${e.stage}`);
        },
      });
      const stageStarts = events.filter((e) => e.startsWith('stage-start:'));
      const stageDones = events.filter((e) => e.startsWith('stage-done:'));
      expect(stageStarts).toEqual([
        'stage-start:discover',
        'stage-start:parse',
        'stage-start:walk',
        'stage-start:resolve',
        'stage-start:index',
        'stage-start:features',
        'stage-start:rules',
      ]);
      expect(stageDones).toEqual([
        'stage-done:discover',
        'stage-done:parse',
        'stage-done:walk',
        'stage-done:resolve',
        'stage-done:index',
        'stage-done:features',
        'stage-done:rules',
      ]);
    });
  });

  it('writes the catalog to the datastore when one is provided and cache is enabled', async () => {
    await inGraphScope(async () => {
      currentAdapterRegistry().register(
        fakeAdapter({
          projectDir,
          occurrences: {
            fn: [occurrence({ bodyHash: 'h-persisted', simpleName: 'fn' })],
          },
        }),
      );
      const result = await runGraph({ cwd: projectDir, rules: [], datastore });
      expect(result.cacheHit).toBe(false);
      const persisted = new CatalogRepo(datastore).loadFullCatalog();
      expect(persisted).not.toBeNull();
      expect(persisted?.functions.fn?.[0]?.bodyHash).toBe('h-persisted');
    });
  });

  it('returns a cache hit when the persisted catalog matches the current key', async () => {
    await inGraphScope(async () => {
      const adapter = fakeAdapter({
        projectDir,
        cacheKey: 'stable-key',
        files: [join(projectDir, 'src', 'a.ts')],
        occurrences: {
          fn: [occurrence({ bodyHash: 'h-fresh', simpleName: 'fn' })],
        },
      });
      currentAdapterRegistry().register(adapter);

      await runGraph({ cwd: projectDir, rules: [], datastore });

      const events: string[] = [];
      const result = await runGraph({
        cwd: projectDir,
        rules: [],
        datastore,
        onProgress: (e) => {
          if (e.type === 'stage-cached') events.push(e.stage);
        },
      });
      expect(result.cacheHit).toBe(true);
      expect(result.catalog).not.toBeNull();
      expect(events).toEqual(['parse', 'walk', 'resolve']);
      expect(result.resolutionStats).toBeNull();
    });
  });

  it('runs rules against the produced catalog + indexes', async () => {
    await inGraphScope(async () => {
      currentAdapterRegistry().register(
        fakeAdapter({
          projectDir,
          occurrences: {
            fn: [occurrence({ bodyHash: 'h1', simpleName: 'fn' })],
          },
        }),
      );
      const evaluate = vi.fn().mockReturnValue([]);
      const rule: Rule = {
        slug: 'graph:test',
        defaultSeverity: 'warning',
        evaluate,
      };
      const result = await runGraph({
        cwd: projectDir,
        noCache: true,
        rules: [rule],
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(result.signals).toEqual([]);
    });
  });

  it('passes the runtime tsConfigPath override into adapter.discoverFiles', async () => {
    await inGraphScope(async () => {
      const seen: string[] = [];
      const a = fakeAdapter({ projectDir });
      const spy = vi.spyOn(a, 'discoverFiles').mockImplementation((inp) => {
        seen.push(inp.configPathOverride ?? 'absent');
        return {
          projectDirAbs: projectDir,
          files: [join(projectDir, 'src', 'a.ts')],
        };
      });
      currentAdapterRegistry().register(a);
      await runGraph({
        cwd: projectDir,
        noCache: true,
        rules: [],
        tsConfigPath: join(projectDir, 'tsconfig.json'),
      });
      expect(seen).toEqual([join(projectDir, 'tsconfig.json')]);
      spy.mockRestore();
    });
  });

  it('skips writing to the datastore when noCache is true', async () => {
    await inGraphScope(async () => {
      currentAdapterRegistry().register(fakeAdapter({ projectDir }));
      await runGraph({ cwd: projectDir, noCache: true, rules: [], datastore });
      expect(new CatalogRepo(datastore).hasAnyCatalog()).toBe(false);
    });
  });

  // Guards a real correctness regression: prior to the fix the
  // orchestrator called `rule.evaluate(catalog, indexes, config)` and
  // dropped the fourth argument, so every non-TypeScript adapter's
  // ruleHints (sideEffectPrimitives, throwSyntaxRegex, isTestFile,
  // generatedFilePatterns) silently fell back to TS-shaped regex.
  it("threads the active adapter's ruleHints into every rule's evaluate call", async () => {
    await inGraphScope(async () => {
      const hints: RuleHints = {
        sideEffectPrimitives: ['builtins.print', 'sys.exit'],
        throwSyntaxRegex: /^\s*raise\s+\w+/,
        generatedFilePatterns: ['**/_pb2.py'],
        isTestFile: (p) => p.startsWith('tests/'),
      };
      currentAdapterRegistry().register(fakeAdapter({ projectDir, ruleHints: hints }));

      const seenHints: (RuleHints | undefined)[] = [];
      const capturingRule: Rule = {
        slug: 'graph:test-hints-capture',
        defaultSeverity: 'warning',
        evaluate: (_catalog, _indexes, _config, h) => {
          seenHints.push(h);
          return [];
        },
      };

      await runGraph({ cwd: projectDir, rules: [capturingRule], datastore });

      expect(seenHints).toHaveLength(1);
      expect(seenHints[0]).toBe(hints);
    });
  });
});

describe('runGraph — incremental rebuild path', () => {
  let datastore: DataStore;
  let dir: string;
  let scope: ReturnType<typeof makeGraphTestScope>;

  beforeEach(() => {
    scope = makeGraphTestScope();
    datastore = DataStoreFactory.open({ backend: 'memory' });
    dir = mkdtempSync(join(tmpdir(), 'orch-incr-'));
  });

  afterEach(() => {
    runWithScopeSync(scope, () => currentAdapterRegistry().clear());
    datastore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function inGraphScope<T>(fn: () => Promise<T>): Promise<T> {
    return runWithScope(scope, fn);
  }

  it('completes the incremental branch when a single file changes', async () => {
    await inGraphScope(async () => {
      const fileA = join(dir, 'src', 'a.ts');
      const fileB = join(dir, 'src', 'b.ts');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(fileA, 'v1');
      writeFileSync(fileB, 'v1');

      currentAdapterRegistry().register(
        fakeAdapter({
          projectDir: dir,
          cacheKey: 'k1',
          files: [fileA, fileB],
          occurrences: {
            fa: [
              occurrence({
                bodyHash: 'hA',
                simpleName: 'fa',
                filePath: 'src/a.ts',
              }),
            ],
            fb: [
              occurrence({
                bodyHash: 'hB',
                simpleName: 'fb',
                filePath: 'src/b.ts',
              }),
            ],
          },
        }),
      );

      await runGraph({ cwd: dir, rules: [], datastore });

      writeFileSync(fileB, 'v2-changed');

      currentAdapterRegistry().clear();
      currentAdapterRegistry().register(
        fakeAdapter({
          projectDir: dir,
          cacheKey: 'k1',
          files: [fileA, fileB],
          occurrences: {
            fa: [
              occurrence({
                bodyHash: 'hA',
                simpleName: 'fa',
                filePath: 'src/a.ts',
              }),
            ],
            fb: [
              occurrence({
                bodyHash: 'hB-new',
                simpleName: 'fb',
                filePath: 'src/b.ts',
              }),
            ],
          },
        }),
      );

      const result = await runGraph({ cwd: dir, rules: [], datastore });
      expect(result.catalog).not.toBeNull();
      // The incremental path completes and produces a catalog without
      // throwing. The merge semantics are exercised in detail by other
      // tests (`graph-catalog-drift`); here we just want to drive the
      // 'incremental' verdict branch in obtainCatalog.
      expect(result.cacheHit).toBe(false);
    });
  });
});
