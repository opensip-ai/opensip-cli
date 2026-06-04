/**
 * graphTool — branch coverage for the option-parsing and scope hooks the
 * primary tool-register suite doesn't reach: --resolution validation
 * (fast + invalid), the graph-shard-worker action, catalog-export's
 * incremental + changed-file advisory branch, the error handler on a
 * pipeline throw, and the contributeScope / collectDashboardData hooks.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, LanguageRegistry } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { Command } from 'commander';
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
import type { ToolCliContext, ToolScope } from '@opensip-tools/core';

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
      stats: { totalCallSites: 0, resolvedHigh: 0, resolvedMedium: 0, resolvedLow: 0, unresolved: 0 },
    }),
    cacheKey: () => 'fake-v1',
  };
}

interface MockCliBag {
  readonly cli: ToolCliContext;
  readonly program: Command;
  readonly setExitCode: MockInstance;
  readonly renderLive: MockInstance;
  readonly render: MockInstance;
}

function makeMockCli(datastore?: DataStore): MockCliBag {
  const program = new Command();
  // Don't let commander call process.exit when an action throws a parse error.
  program.exitOverride();
  const setExitCode = vi.fn();
  const renderLive = vi.fn().mockResolvedValue(undefined);
  const render = vi.fn().mockResolvedValue(undefined);
  const cli = {
    program,
    registerLiveView: vi.fn(),
    renderLive,
    render,
    setExitCode,
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    datastore,
    scope: { datastore: () => datastore, languages: new LanguageRegistry() },
  } as unknown as ToolCliContext;
  return { cli, program, setExitCode, renderLive, render };
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

describe('--resolution validation', () => {
  it('rejects an invalid --resolution value with a ValidationError', async () => {
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const { cli, program } = makeMockCli();
    graphTool.register(cli);
    await expect(
      program.parseAsync(
        ['graph', '--json', '--resolution', 'bogus', join(workDir, 'sub')],
        { from: 'user' },
      ),
    ).rejects.toThrow(/--resolution must be 'exact' or 'fast'/);
  });

  it('accepts --resolution fast on the sarif-export path', async () => {
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const outPath = join(workDir, 'out.sarif');
    const { cli, program, setExitCode } = makeMockCli(DataStoreFactory.open({ backend: 'memory' }));
    graphTool.register(cli);
    await program.parseAsync(
      [
        'sarif-export',
        '--output-sarif', outPath,
        '--tenant-id', 't',
        '--repo-id', 'r',
        '--cwd', workDir,
        '--resolution', 'fast',
      ],
      { from: 'user' },
    );
    expect(setExitCode).toHaveBeenCalledWith(0);
  });
});

describe('interactive default path honors graph config', () => {
  it('loads opensip-tools.config.yml graph block and forwards it to renderLive (TTY)', async () => {
    // Regression: the interactive live-view path (bare `graph`) used to
    // call runGraph with no config, silently ignoring the project's
    // `graph:` block — so `graph --verbose` disagreed with `graph --json`.
    currentAdapterRegistry().register(fakeAdapter(workDir));
    writeFileSync(
      join(workDir, 'opensip-tools.config.yml'),
      'graph:\n  minCrossPackageDuplicatePackages: 2\n',
      'utf8',
    );
    const { cli, program, renderLive } = makeMockCli();
    graphTool.register(cli);

    // The animated live view is taken only on a TTY.
    await withTTY(true, () => program.parseAsync(['graph', '--cwd', workDir], { from: 'user' }));

    expect(renderLive).toHaveBeenCalledTimes(1);
    const [, args] = renderLive.mock.calls[0] as [string, { config?: { minCrossPackageDuplicatePackages?: number } }];
    expect(args.config?.minCrossPackageDuplicatePackages).toBe(2);
  });

  it('falls back to the static render seam (not the live view) when stdout is not a TTY', async () => {
    // Pipe / CI / redirect: the animated Ink live view is TTY-only, so a bare
    // `graph` run must route through executeGraph and emit its result through
    // the render seam (dual-rendered as plain text), never renderLive.
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const { cli, program, renderLive, render } = makeMockCli(
      DataStoreFactory.open({ backend: 'memory' }),
    );
    graphTool.register(cli);

    await withTTY(false, () => program.parseAsync(['graph', '--cwd', workDir], { from: 'user' }));

    expect(renderLive).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
    const [result] = render.mock.calls[0] as [{ type?: string }];
    expect(result.type).toBe('graph-done');
  });
});

describe('graph-shard-worker action', () => {
  it('routes the specPath argument to executeShardWorker (exit 0 on a valid spec)', async () => {
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const specPath = join(workDir, 'spec.json');
    const spec: ShardWorkerSpec = {
      shard: { id: 'pkg:a', rootDir: workDir, files: [join(workDir, 'src', 'a.ts')] },
      projectRoot: workDir,
      resolutionMode: 'exact',
    };
    writeFileSync(specPath, JSON.stringify(spec), 'utf8');
    const { cli, program, setExitCode } = makeMockCli();
    graphTool.register(cli);
    await program.parseAsync(['graph-shard-worker', specPath], { from: 'user' });
    expect(setExitCode).toHaveBeenCalledWith(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const result = JSON.parse(out) as ShardBuildResult;
    expect(result.shardId).toBe('pkg:a');
  });
});

describe('catalog-export action branches', () => {
  it('logs the changed-file advisory on the incremental path and still writes the export', async () => {
    currentAdapterRegistry().register(fakeAdapter(workDir));
    const outPath = join(workDir, 'catalog.json');
    const { cli, program, setExitCode } = makeMockCli(DataStoreFactory.open({ backend: 'memory' }));
    graphTool.register(cli);
    await program.parseAsync(
      [
        'catalog-export',
        '--catalog-output', outPath,
        '--tenant-id', 't',
        '--repo-id', 'r',
        '--git-sha', 'sha1',
        '--mode', 'incremental',
        '--changed-file', 'src/a.ts',
        '--changed-file', 'src/b.ts',
        '--cwd', workDir,
      ],
      { from: 'user' },
    );
    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it('routes a pipeline failure through handleGraphError (no adapter registered)', async () => {
    // No adapter registered → runGraph throws a ConfigurationError, which
    // the action's catch hands to handleGraphError.
    const outPath = join(workDir, 'catalog.json');
    const { cli, program, setExitCode } = makeMockCli(DataStoreFactory.open({ backend: 'memory' }));
    graphTool.register(cli);
    await program.parseAsync(
      [
        'catalog-export',
        '--catalog-output', outPath,
        '--tenant-id', 't',
        '--repo-id', 'r',
        '--git-sha', 'sha1',
        '--cwd', workDir,
      ],
      { from: 'user' },
    );
    // handleGraphError sets a non-zero exit code.
    const codes = setExitCode.mock.calls.map((c) => c[0]);
    expect(codes.some((c) => c !== 0)).toBe(true);
  });
});

describe('contributeScope + collectDashboardData hooks', () => {
  it('contributeScope seeds a fresh graph subscope with adapter + rule + recipe registries', () => {
    const contribution = graphTool.contributeScope?.() ?? {};
    expect(contribution.graph).toBeDefined();
    expect(contribution.graph?.adapters).toBeDefined();
    expect(contribution.graph?.rules).toBeDefined();
    expect(contribution.graph?.recipes).toBeDefined();
  });

  it('collectDashboardData returns empty rule/recipe catalogs when no datastore and no graph subscope', () => {
    const scope = { datastore: () => undefined } as unknown as ToolScope;
    expect(graphTool.collectDashboardData?.(scope)).toEqual({
      graphRuleCatalog: [],
      graphRecipeCatalog: [],
    });
  });

  it('collectDashboardData returns a graphCatalog key when a datastore is present', () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const scope = { datastore: () => datastore } as unknown as ToolScope;
      const data = graphTool.collectDashboardData?.(scope) ?? {};
      expect('graphCatalog' in data).toBe(true);
    } finally {
      datastore.close();
    }
  });
});
