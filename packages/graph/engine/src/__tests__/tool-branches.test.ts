/**
 * graphTool — branch coverage for the spec-handler paths the primary
 * tool-register suite doesn't reach: the `--resolution` choices declaration
 * (+ the `fast` path), the graph-shard-worker handler, catalog-export's
 * incremental + changed-file advisory branch, the error handler on a pipeline
 * throw, and the contributeScope / collectReportData hooks.
 *
 * Since release 2.11.0 Phase 5 graph mounts via `commandSpecs`; we drive each
 * spec's handler directly (the host invokes it post-parse), threading
 * positionals on the parsed-opts object under `_args`. `--resolution` is now
 * validated declaratively (`choices: ['exact','fast']`) by the host's mount
 * layer — its rejection of an out-of-set value is covered in
 * `cli/src/__tests__/mount-command-spec.test.ts`; here we assert the spec
 * DECLARES the choices (the source of truth) and that the `fast` value flows
 * through.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, LanguageRegistry } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { currentAdapterRegistry } from '../lang-adapter/registry.js';
import { graphTool } from '../tool.js';

import { makeGraphTestScope } from './test-utils/with-graph-scope.js';

import type { ShardBuildResult, ShardWorkerSpec } from '../cli/orchestrate/shard-model.js';
import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../lang-adapter/types.js';
import type { CommandHandler, CommandSpec, ToolCliContext, ToolScope } from '@opensip-cli/core';

/** Resolve a graph command-spec by name. */
function specFor(name: string): CommandSpec<unknown, ToolCliContext> {
  const spec = (graphTool.commandSpecs ?? []).find((s) => s.name === name);
  if (spec === undefined) throw new Error(`graphTool exposes no command spec '${name}'`);
  return spec;
}

/** Resolve a graph command-spec handler by name (the host invokes `handler(opts, ctx)`). */
function handlerFor(name: string): CommandHandler<unknown, ToolCliContext> {
  return specFor(name).handler;
}

function fakeAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'typescript',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: projectDir,
      files: [join(projectDir, 'src', 'a.ts')],
      configPathAbs: undefined,
      compilerOptions: undefined,
    }),
    parseProject: (): ParseOutput => ({ project: { x: 1 }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({ occurrences: {}, callSites: [], parseErrors: [] }),
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
    cacheKey: () => 'fake-v1',
  };
}

interface MockCliBag {
  readonly cli: ToolCliContext;
  readonly setExitCode: MockInstance;
  readonly renderLive: MockInstance;
  readonly render: MockInstance;
}

function makeMockCli(datastore?: DataStore): MockCliBag {
  const setExitCode = vi.fn();
  const renderLive = vi.fn().mockResolvedValue(undefined);
  const render = vi.fn().mockResolvedValue(undefined);
  const cli = {
    registerLiveView: vi.fn(),
    renderLive,
    render,
    setExitCode,
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore,
    scope: { datastore: () => datastore, languages: new LanguageRegistry() },
  } as unknown as ToolCliContext;
  return { cli, setExitCode, renderLive, render };
}

/** Force `process.stdout.isTTY` for one test, restoring the prior value after. */
async function withTTY(value: boolean | undefined, fn: () => Promise<unknown>): Promise<void> {
  const prev = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', { value: prev, configurable: true });
  }
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let workDir: string;

beforeEach(() => {
  enterScope(makeGraphTestScope());
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  workDir = mkdtempSync(join(tmpdir(), 'tool-branch-'));
});

afterEach(() => {
  currentAdapterRegistry().clear();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(workDir, { recursive: true, force: true });
});

describe('--resolution declaration', () => {
  it('declares choices exact|fast on every --resolution-bearing command', () => {
    for (const name of ['graph', 'catalog-export', 'sarif-export']) {
      const option = (specFor(name).options ?? []).find((o) => o.flag === '--resolution');
      expect(option?.choices).toEqual(['exact', 'fast']);
      expect(option?.default).toBe('exact');
    }
  });

  it('accepts --resolution fast on the sarif-export path', async () => {
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const outPath = join(workDir, 'out.sarif');
    const { cli, setExitCode } = makeMockCli(DataStoreFactory.open({ backend: 'memory' }));
    await handlerFor('sarif-export')(
      {
        outputSarif: outPath,
        tenantId: 't',
        repoId: 'r',
        cwd: workDir,
        resolution: 'fast',
        _args: [],
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(0);
  });
});

describe('graph interactive --exact path honors graph config', () => {
  it('loads opensip-cli.config.yml graph block and forwards it to renderLive (--exact, TTY)', async () => {
    // Regression: the interactive live-view path used to call runGraph with no
    // config, silently ignoring the project's `graph:` block — so
    // `graph --verbose` disagreed with `graph --json`. ADR-0032: the Ink live
    // view drives the EXACT engine, so it is eligible only under `--exact`
    // (sharded is the default and routes to the static path).
    currentAdapterRegistry().register(fakeAdapter(workDir));
    writeFileSync(
      join(workDir, 'opensip-cli.config.yml'),
      'graph:\n  minCrossPackageDuplicatePackages: 2\n',
      'utf8',
    );
    const { cli, renderLive } = makeMockCli();

    // The animated live view is taken only on a TTY, under --exact.
    await withTTY(
      true,
      () =>
        handlerFor('graph')({ cwd: workDir, exact: true, _args: [[]] }, cli) as Promise<unknown>,
    );

    expect(renderLive).toHaveBeenCalledTimes(1);
    const [, args] = renderLive.mock.calls[0] as [
      string,
      { config?: { minCrossPackageDuplicatePackages?: number } },
    ];
    expect(args.config?.minCrossPackageDuplicatePackages).toBe(2);
  });

  it('falls back to the static render seam (not the live view) when stdout is not a TTY', async () => {
    // Pipe / CI / redirect: the animated Ink live view is TTY-only, so a bare
    // `graph` run must route through executeGraph and emit its result through
    // the render seam (dual-rendered as plain text), never renderLive.
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const { cli, renderLive, render } = makeMockCli(DataStoreFactory.open({ backend: 'memory' }));

    await withTTY(
      false,
      () => handlerFor('graph')({ cwd: workDir, _args: [[]] }, cli) as Promise<unknown>,
    );

    expect(renderLive).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
    const [result] = render.mock.calls[0] as [{ type?: string }];
    expect(result.type).toBe('graph-done');
  });

  it('a bare default run takes the live view on a TTY (ADR-0032: the live renderer is engine-agnostic — drives the sharded default too)', async () => {
    // Regression fix: the live runner is engine-agnostic — it drives WHICHEVER
    // engine the `--exact` + shardability policy selects (sharded in-process /
    // exact off-process). So a bare `graph` (sharded default) on a TTY MUST take
    // the live view — same as `--exact` — restoring the staged "Code Graph"
    // checklist that the earlier `opts.exact === true` gate had removed. This
    // pins "TTY selects only the renderer; it never changes the engine" without
    // tying the renderer to one engine.
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const { cli, renderLive, render } = makeMockCli(DataStoreFactory.open({ backend: 'memory' }));

    await withTTY(
      true,
      () => handlerFor('graph')({ cwd: workDir, _args: [[]] }, cli) as Promise<unknown>,
    );

    expect(renderLive).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    // The live args carry the engine selector: `exact` (false here) + the
    // pre-resolved shard set the runner uses to pick its transport.
    const [, args] = renderLive.mock.calls[0] as [
      string,
      { exact?: boolean; shards?: readonly unknown[] },
    ];
    expect(args.exact).toBe(false);
    expect(Array.isArray(args.shards)).toBe(true);
  });
});

describe('graph-shard-worker handler', () => {
  it('routes the specPath positional to executeShardWorker (exit 0 on a valid spec)', async () => {
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const specPath = join(workDir, 'spec.json');
    const spec: ShardWorkerSpec = {
      shard: { id: 'pkg:a', rootDir: workDir, files: [join(workDir, 'src', 'a.ts')] },
      projectRoot: workDir,
      resolutionMode: 'exact',
    };
    writeFileSync(specPath, JSON.stringify(spec), 'utf8');
    const { cli, setExitCode } = makeMockCli();
    await handlerFor('graph-shard-worker')({ _args: [specPath] }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const result = JSON.parse(out) as ShardBuildResult;
    expect(result.shardId).toBe('pkg:a');
  });
});

describe('catalog-export handler branches', () => {
  it('logs the changed-file advisory on the incremental path and still writes the export', async () => {
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const outPath = join(workDir, 'catalog.json');
    const { cli, setExitCode } = makeMockCli(DataStoreFactory.open({ backend: 'memory' }));
    await handlerFor('catalog-export')(
      {
        catalogOutput: outPath,
        tenantId: 't',
        repoId: 'r',
        gitSha: 'sha1',
        mode: 'incremental',
        changedFile: ['src/a.ts', 'src/b.ts'],
        cwd: workDir,
        resolution: 'exact',
        _args: [],
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it('routes a pipeline failure through handleGraphError (no adapter registered)', async () => {
    // No adapter registered → runGraph throws a ConfigurationError, which
    // the handler's catch hands to handleGraphError.
    const outPath = join(workDir, 'catalog.json');
    const { cli, setExitCode } = makeMockCli(DataStoreFactory.open({ backend: 'memory' }));
    await handlerFor('catalog-export')(
      {
        catalogOutput: outPath,
        tenantId: 't',
        repoId: 'r',
        gitSha: 'sha1',
        cwd: workDir,
        resolution: 'exact',
        _args: [],
      },
      cli,
    );
    // handleGraphError sets a non-zero exit code.
    const codes = setExitCode.mock.calls.map((c) => c[0]);
    expect(codes.some((c) => c !== 0)).toBe(true);
  });
});

describe('contributeScope + collectReportData hooks', () => {
  it('contributeScope seeds a fresh graph subscope with adapter + rule + recipe registries', () => {
    const contribution = graphTool.contributeScope?.() ?? {};
    expect(contribution.graph).toBeDefined();
    expect(contribution.graph?.adapters).toBeDefined();
    expect(contribution.graph?.rules).toBeDefined();
    expect(contribution.graph?.recipes).toBeDefined();
  });

  it('collectReportData returns empty rule/recipe catalogs when no datastore and no graph subscope', () => {
    const scope = { datastore: () => undefined } as unknown as ToolScope;
    expect(graphTool.collectReportData?.(scope)).toEqual({
      graphRuleCatalog: [],
      graphRecipeCatalog: [],
    });
  });

  it('collectReportData returns a graphCatalog key when a datastore is present', () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const scope = { datastore: () => datastore } as unknown as ToolScope;
      const data = graphTool.collectReportData?.(scope) ?? {};
      expect('graphCatalog' in data).toBe(true);
    } finally {
      datastore.close();
    }
  });
});
