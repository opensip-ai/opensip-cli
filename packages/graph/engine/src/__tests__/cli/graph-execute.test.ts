/**
 * `executeGraph` dispatch branches: mutually-exclusive flag validation,
 * the verbose vs default vs JSON render paths, multi-path aggregation,
 * and the --workspace error guards (no CLI script, no detected units).
 * These exercise the synchronous dispatch logic in cli/graph.ts that the
 * narrower language-mismatch + tool-register suites don't reach.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, LanguageRegistry } from '@opensip-tools/core';
import { BaselineRepo, DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { diffBaseline } from '@opensip-tools/output';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { executeGraph } from '../../cli/graph.js';
import { currentAdapterRegistry } from '../../lang-adapter/registry.js';
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type { FunctionOccurrence } from '../../types.js';
import type { GraphDoneResult, SignalEnvelope } from '@opensip-tools/contracts';
import type { ToolCliContext } from '@opensip-tools/core';

function occ(over: Partial<FunctionOccurrence> = {}): FunctionOccurrence {
  return {
    bodyHash: 'h1',
    simpleName: 'fn',
    qualifiedName: 'src/a.fn',
    filePath: 'src/a.ts',
    line: 1,
    column: 0,
    endLine: 3,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

// An adapter that "discovers" one file per project dir and walks one
// exported occurrence, so the catalog is non-empty (file count > 0).
function populatedAdapter(): GraphLanguageAdapter {
  return {
    id: 'typescript',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    discoverFiles: ({ cwd }: { cwd: string }): DiscoverOutput => ({
      projectDirAbs: cwd,
      files: [join(cwd, 'src', 'a.ts')],
      configPathAbs: undefined,
      compilerOptions: undefined,
    }),
    parseProject: (): ParseOutput => ({ project: { x: 1 }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: { fn: [occ()] },
      callSites: [],
      parseErrors: [],
    }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map([['h1', []]]),
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
  readonly render: MockInstance;
  readonly emitEnvelope: MockInstance;
}

function mockCli(datastore?: DataStore): MockCliBag {
  const setExitCode = vi.fn();
  const render = vi.fn(() => Promise.resolve());
  const emitEnvelope = vi.fn();
  // ADR-0036: stub the host baseline seams against the test datastore, and map
  // the deliverSignals runFailed override to setExitCode exactly as the host does.
  const repo = (): BaselineRepo => new BaselineRepo(datastore!);
  return {
    cli: {
      setExitCode,
      emitJson: vi.fn(),
      emitEnvelope,
      deliverSignals: vi.fn((_env: unknown, opts?: { runFailed?: boolean }) => {
        setExitCode(opts?.runFailed === true ? 1 : 0);
        return Promise.resolve();
      }),
      writeSarif: vi.fn(() => Promise.resolve()),
      saveBaseline: vi.fn((tool: string, env: unknown) => {
        repo().save(
          tool,
          (env as SignalEnvelope).signals.map((s) => ({
            fingerprint: s.fingerprint ?? '',
            payload: s,
          })),
        );
        return Promise.resolve();
      }),
      compareBaseline: vi.fn((tool: string, env: unknown) =>
        Promise.resolve(diffBaseline((env as SignalEnvelope).signals, repo().load(tool))),
      ),
      exportBaselineSarif: vi.fn(() => Promise.resolve()),
      exportBaselineFingerprints: vi.fn(() => Promise.resolve()),
      render,
      scope: { datastore: () => datastore, languages: new LanguageRegistry() },
    } as unknown as ToolCliContext,
    setExitCode,
    render,
    emitEnvelope,
  };
}

/** Concatenated text of every `gate-done` result handed to cli.render(). */
function renderedLines(render: MockInstance): string {
  return (render.mock.calls as unknown as readonly [{ lines?: readonly string[] }][])
    .map((c) => c[0].lines?.join('\n') ?? '')
    .join('\n');
}

// A large flat TypeScript adapter that synthetic-shards (>1 partition) so the
// engine-selection branch is exercised. Registered under the given cwd.
function registerLargeFlatAdapter(cwdDir: string): void {
  const files = Array.from({ length: 2501 }, (_unused, i) =>
    join(cwdDir, 'src', `file-${String(i)}.ts`),
  );
  const largeFlatAdapter: GraphLanguageAdapter = {
    ...populatedAdapter(),
    discoverFiles: ({ cwd }: { cwd: string }): DiscoverOutput => ({
      projectDirAbs: cwd,
      files,
      configPathAbs: join(cwd, 'tsconfig.json'),
      compilerOptions: undefined,
    }),
  };
  currentAdapterRegistry().register(largeFlatAdapter);
}

// A fake shard-worker CLI that emits one ShardBuildResult per spawned shard,
// so the sharded build path completes end-to-end without the real worker.
function writeFakeShardCli(cwdDir: string): string {
  const fakeCliPath = join(cwdDir, 'fake-shard-cli.cjs');
  writeFileSync(
    fakeCliPath,
    String.raw`
const { readFileSync } = require('node:fs');
const spec = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const id = spec.shard.id;
const name = id.replace(/[^a-zA-Z0-9]/g, '_');
const occ = {
  bodyHash: 'h-' + id, simpleName: name, qualifiedName: id + '.' + name,
  filePath: 'src/' + name + '.ts', line: 1, column: 0, endLine: 1,
  kind: 'function-declaration', params: [], returnType: null,
  enclosingClass: null, decorators: [], visibility: 'exported',
  inTestFile: false, definedInGenerated: false, calls: [],
};
const result = {
  shardId: id,
  fragment: {
    version: '3.0', tool: 'graph', language: 'typescript', builtAt: 'x',
    cacheKey: 'k-' + id, resolutionMode: spec.resolutionMode,
    functions: { [name]: [occ] },
  },
  fingerprint: 'fp-' + id,
  boundaryCalls: [],
  parseErrors: [],
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`,
    'utf8',
  );
  return fakeCliPath;
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let projectDir: string;

beforeEach(() => {
  enterScope(makeGraphTestScope());
  projectDir = mkdtempSync(join(tmpdir(), 'graph-exec-'));
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'a.ts'), 'export const x = 1;\n', 'utf8');
  // Suppress (don't capture) stdout noise — the `--json` mode now routes
  // through the `cli.emitEnvelope` mock, asserted directly.
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  currentAdapterRegistry().clear();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('executeGraph — mutually-exclusive flags', () => {
  it('rejects --gate-save together with --gate-compare (exit 2)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const { cli, setExitCode } = mockCli();
    await executeGraph({ cwd: projectDir, noCache: true, gateSave: true, gateCompare: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('mutually exclusive');
  });

  it('rejects --workspace together with positional paths (exit 2)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const { cli, setExitCode } = mockCli();
    await executeGraph(
      { cwd: projectDir, noCache: true, workspace: true, paths: [projectDir] },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('mutually exclusive');
  });
});

describe('executeGraph — render dispatch', () => {
  it('emits the signal envelope under --json (exit 0)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode, emitEnvelope } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true, json: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      const envelope = emitEnvelope.mock.calls[0]?.[0] as { tool: string; schemaVersion: number };
      expect(envelope.tool).toBe('graph');
      expect(envelope.schemaVersion).toBe(2);
    } finally {
      datastore.close();
    }
  });

  it('produces a verbose graph-done result with the unified report body', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode, render } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true, verbose: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      const done = render.mock.calls[0]?.[0] as GraphDoneResult;
      expect(done.type).toBe('graph-done');
      const body = done.verboseDetail?.kind === 'lines' ? done.verboseDetail.lines.join('\n') : '';
      expect(body).toContain('== Catalog ==');
      expect(typeof done.summary.passed).toBe('number');
    } finally {
      datastore.close();
    }
  });

  it('produces a default (non-verbose) graph-done result with no verbose body', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode, render } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      const done = render.mock.calls[0]?.[0] as GraphDoneResult;
      expect(done.type).toBe('graph-done');
      // The "Use --verbose…" footer is now emitted by the shared resultToView
      // seam (ADR-0021), not carried on the result.
      expect(done.verboseDetail).toBeUndefined();
    } finally {
      datastore.close();
    }
  });

  it('uses the SHARDED engine by default for a shardable project (ADR-0032)', async () => {
    // A bare run (no --exact) on a shardable repo builds with the SHARDED
    // engine — the default, equivalent to exact within the CI-ratcheted
    // budget held by the equivalence guardrails (ADR-0032 amendment).
    registerLargeFlatAdapter(projectDir);
    const fakeCliPath = writeFakeShardCli(projectDir);
    const profilePath = join(projectDir, 'profile-default.json');
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph(
        {
          cwd: projectDir,
          noCache: true,
          // No `exact: true` — the default. A working worker script is present so
          // the sharded build completes.
          cliScript: fakeCliPath,
          concurrency: 1,
          profileOutput: profilePath,
        },
        cli,
      );
      expect(setExitCode).toHaveBeenCalledWith(0);
      const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
        runs: { mode: string; stages: { name: string; detail?: string }[] }[];
      };
      expect(profile.runs[0]?.mode).toBe('sharded');
      expect(profile.runs[0]?.stages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'sharded-build', detail: '2 shard(s)' }),
        ]),
      );
    } finally {
      datastore.close();
    }
  });

  it('uses the EXACT single-program engine when --exact is set, even on a shardable project (ADR-0032)', async () => {
    // --exact opts OUT of the default sharded engine: a shardable repo with a
    // working worker script must still build single-process (exact). Proves the
    // policy keys off the flag, not script availability or file count.
    registerLargeFlatAdapter(projectDir);
    const fakeCliPath = writeFakeShardCli(projectDir);
    const profilePath = join(projectDir, 'profile-exact.json');
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph(
        {
          cwd: projectDir,
          noCache: true,
          exact: true,
          cliScript: fakeCliPath,
          profileOutput: profilePath,
        },
        cli,
      );
      expect(setExitCode).toHaveBeenCalledWith(0);
      const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
        runs: { mode: string }[];
      };
      expect(profile.runs[0]?.mode).toBe('single-process');
    } finally {
      datastore.close();
    }
  });

  it('falls back to the EXACT engine on a NON-shardable project (no worker script, default policy)', async () => {
    // The natural single-package / small-repo path: even without --exact, a
    // project that can't shard (here: no cliScript to spawn workers) uses the
    // exact single-program engine rather than failing.
    registerLargeFlatAdapter(projectDir);
    const profilePath = join(projectDir, 'profile-fallback.json');
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph(
        {
          cwd: projectDir,
          noCache: true,
          // No cliScript → resolveShards returns [] → exact fallback. No --exact.
          cliScript: '',
          profileOutput: profilePath,
        },
        cli,
      );
      expect(setExitCode).toHaveBeenCalledWith(0);
      const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
        runs: { mode: string }[];
      };
      expect(profile.runs[0]?.mode).toBe('single-process');
    } finally {
      datastore.close();
    }
  });

  it('engine choice is independent of process.stdout.isTTY (TTY selects only the renderer)', async () => {
    // executeGraph is the STATIC path; the engine decision is a pure function of
    // the parsed options + shardability and never reads isTTY. Force isTTY true
    // and confirm a bare default run still shards (same as the non-TTY case).
    registerLargeFlatAdapter(projectDir);
    const fakeCliPath = writeFakeShardCli(projectDir);
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const profilePath = join(projectDir, 'profile-tty.json');
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph(
        {
          cwd: projectDir,
          noCache: true,
          cliScript: fakeCliPath,
          concurrency: 1,
          profileOutput: profilePath,
        },
        cli,
      );
      expect(setExitCode).toHaveBeenCalledWith(0);
      const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
        runs: { mode: string }[];
      };
      // Sharded regardless of isTTY — the engine is TTY-independent.
      expect(profile.runs[0]?.mode).toBe('sharded');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
      datastore.close();
    }
  });
});

describe('executeGraph — multiple positional paths', () => {
  it('aggregates signals across paths and dispatches once', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const other = mkdtempSync(join(tmpdir(), 'graph-exec2-'));
    mkdirSync(join(other, 'src'), { recursive: true });
    writeFileSync(join(other, 'src', 'a.ts'), 'export const y = 2;\n', 'utf8');
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode, emitEnvelope } = mockCli(datastore);
      await executeGraph(
        { cwd: projectDir, noCache: true, json: true, paths: [projectDir, other] },
        cli,
      );
      expect(setExitCode).toHaveBeenCalledWith(0);
      const envelope = emitEnvelope.mock.calls[0]?.[0] as { tool: string };
      expect(envelope.tool).toBe('graph');
    } finally {
      datastore.close();
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('executeGraph — gate dispatch', () => {
  it('saves the gate baseline under --gate-save (exit 0)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode, render } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true, gateSave: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      expect(renderedLines(render)).toContain('Graph baseline saved');
    } finally {
      datastore.close();
    }
  });

  it('compares against the baseline under --gate-compare (exit 0, no regressions)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const save = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true, gateSave: true }, save.cli);
      const compare = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true, gateCompare: true }, compare.cli);
      expect(compare.setExitCode).toHaveBeenCalledWith(0);
      expect(renderedLines(compare.render)).toContain('Graph gate PASS');
    } finally {
      datastore.close();
    }
  });

  it('refuses the gate on a fast-resolution catalog (exit 2)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph(
        { cwd: projectDir, noCache: true, gateSave: true, resolution: 'fast' },
        cli,
      );
      expect(setExitCode).toHaveBeenCalledWith(2);
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('fast');
    } finally {
      datastore.close();
    }
  });
});

describe('executeGraph — --workspace guards', () => {
  it('errors when the CLI entry script cannot be determined (exit 2)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const { cli, setExitCode } = mockCli();
    await executeGraph({ cwd: projectDir, noCache: true, workspace: true, cliScript: '' }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('CLI entry script');
  });

  it('errors when --language names an unregistered adapter (exit 2)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const { cli, setExitCode } = mockCli();
    // resolveAdaptersForRun reads cli.scope.languages (empty here) → the
    // language name isn't registered → ConfigurationError.
    await executeGraph(
      { cwd: projectDir, noCache: true, workspace: true, cliScript: 'cli.js', language: 'klingon' },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain(
      'not a registered adapter',
    );
  });
});
