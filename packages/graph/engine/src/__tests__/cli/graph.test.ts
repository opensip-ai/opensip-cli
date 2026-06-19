// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while covered domains are split into focused tests.
/**
 * Tests for `executeGraph` — the main `opensip graph` command
 * handler. Drives the full pipeline with a synthetic adapter and
 * exercises every branch the handler can take: human report, JSON,
 * gate-save, gate-compare (pass + degraded), report-to (cloud),
 * configuration errors, and packages aggregation.
 *
 * Also exercises `buildUnifiedReportLines` directly so the unified-
 * report renderer is covered without depending on the Ink runner.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, createSignal, enterScope, LanguageRegistry } from '@opensip-cli/core';
import { BaselineRepo, DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { diffBaseline } from '@opensip-cli/output';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { buildUnifiedReportLines, executeGraph } from '../../cli/graph.js';
import { currentAdapterRegistry } from '../../lang-adapter/registry.js';
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type { Catalog, FunctionOccurrence, Indexes } from '../../types.js';
import type { RunPresentation, SignalEnvelope } from '@opensip-cli/contracts';
import type { LanguageAdapter, Signal, ToolCliContext, WorkspaceUnit } from '@opensip-cli/core';

function fakeAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'fake',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: projectDir,
      files: [join(projectDir, 'src', 'a.ts')],
    }),
    parseProject: (): ParseOutput => ({ project: { dummy: true }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {
        fn: [
          {
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
          },
        ],
      },
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
    cacheKey: () => 'fake-key-v1',
  };
}

interface MockCli {
  readonly cli: ToolCliContext;
  readonly setExitCode: MockInstance;
  /** Captures the CommandResult(s) executeGraph hands to cli.render(). */
  readonly render: MockInstance;
  /** Captures the envelope executeGraph hands to cli.emitEnvelope() under --json. */
  readonly emitEnvelope: MockInstance;
  /** Captures the JSON document executeGraph hands to cli.emitJson() (--workspace --json). */
  readonly emitJson: MockInstance;
}

function mockCli(datastore: DataStore | undefined, languages?: LanguageRegistry): MockCli {
  const setExitCode = vi.fn();
  const render = vi.fn(() => Promise.resolve());
  const emitEnvelope = vi.fn();
  const emitJson = vi.fn();
  const resolvedLanguages = languages ?? new LanguageRegistry();
  // ADR-0036: the host owns the baseline seams + the gate exit. These stubs mirror
  // the real host seams against the test datastore, and map the deliverSignals
  // runFailed override to setExitCode exactly as the host's deliver-envelope does —
  // so the gate tests assert the host-derived exit through the same observable.
  const requireDs = (): DataStore => {
    if (!datastore) throw new ConfigurationError('Graph gate mode requires a DataStore.');
    return datastore;
  };
  const saveBaselineSeam = vi.fn((tool: string, env: unknown) => {
    const e = env as SignalEnvelope;
    new BaselineRepo(requireDs()).save(
      tool,
      e.signals.map((s) => ({ fingerprint: s.fingerprint ?? '', payload: s })),
    );
    return Promise.resolve();
  });
  const compareBaselineSeam = vi.fn((tool: string, env: unknown) => {
    const repo = new BaselineRepo(requireDs());
    if (!repo.exists(tool)) {
      return Promise.reject(new ConfigurationError(`No baseline found for '${tool}'.`));
    }
    return Promise.resolve(diffBaseline((env as SignalEnvelope).signals, repo.load(tool)));
  });
  const deliverSignals = vi.fn((_env: unknown, opts?: { runFailed?: boolean }) => {
    setExitCode(opts?.runFailed === true ? 1 : 0);
    return Promise.resolve();
  });
  return {
    cli: {
      datastore,
      setExitCode,
      render,
      emitEnvelope,
      emitJson,
      deliverSignals,
      saveBaseline: saveBaselineSeam,
      compareBaseline: compareBaselineSeam,
      exportBaselineSarif: vi.fn(() => Promise.resolve()),
      exportBaselineFingerprints: vi.fn(() => Promise.resolve()),
      scope: { datastore: () => datastore, languages: resolvedLanguages },
    } as unknown as ToolCliContext,
    setExitCode,
    render,
    emitEnvelope,
    emitJson,
  };
}

/**
 * Concatenated text of every `gate-done` / `graph-status` result handed to
 * cli.render() — gate and workspace human output now flow through the render
 * seam rather than direct stdout writes.
 */
function renderedLines(render: MockInstance): string {
  return (render.mock.calls as unknown as readonly [{ lines?: readonly string[] }][])
    .map((c) => c[0].lines?.join('\n') ?? '')
    .join('\n');
}

function makeWorkspaceLangRegistry(units: readonly WorkspaceUnit[]): LanguageRegistry {
  const registry = new LanguageRegistry();
  const adapter: LanguageAdapter = {
    id: 'typescript',
    fileExtensions: ['.ts'],
    parse: () => null,
    stripStrings: (s) => s,
    stripComments: (s) => s,
    // eslint-disable-next-line @typescript-eslint/require-await
    discoverWorkspaceUnits: async () => units,
  };
  registry.register(adapter);
  return registry;
}

function sig(over: { ruleId: string; message: string; filePath: string; line?: number }): Signal {
  return createSignal({
    source: 'graph',
    severity: 'low',
    category: 'quality',
    ruleId: over.ruleId,
    message: over.message,
    code: { file: over.filePath, line: over.line ?? 1, column: 0 },
  });
}

function makeIndexes(): Indexes {
  return {
    byBodyHash: new Map(),
    byOccId: new Map(),
    occurrencesByHash: new Map(),
    importedPackagesByFile: new Map(),
    bySimpleName: new Map(),
    callees: new Map(),
    callers: new Map(),
  };
}

function makeCatalog(): Catalog {
  const occurrence: FunctionOccurrence = {
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
  };
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    functions: { fn: [occurrence] },
  };
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let projectDir: string;

beforeEach(() => {
  // Item 1: graph adapter + rule registries are per-RunScope.
  enterScope(makeGraphTestScope());
  projectDir = mkdtempSync(join(tmpdir(), 'graph-test-proj-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  currentAdapterRegistry().clear();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('executeGraph — human / JSON modes', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    currentAdapterRegistry().register(fakeAdapter(projectDir));
  });

  afterEach(() => {
    datastore.close();
  });

  it('produces a RunPresentation carrying the envelope and host duration on the default (non-verbose) path', async () => {
    const { cli, setExitCode, render } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    // envelope-first-presentation RP-2: executeGraph now hands a RunPresentation
    // to the central render seam; the PASS/FAIL summary and optional verbose
    // table are derived from the carried envelope (rendering is the CLI's
    // concern, covered there). Here we assert the result graph produced.
    const done = render.mock.calls[0]?.[0] as RunPresentation;
    expect(done.type).toBe('run-presentation');
    expect(done.tool).toBe('graph');
    // The envelope is the findings currency — the verdict derives from it.
    expect(done.envelope.tool).toBe('graph');
    expect(done.envelope.schemaVersion).toBe(2);
    // host-owned display duration (ADR-0051), threaded so the summary shows the
    // real wall-clock rather than the unit-sum (graph units carry durationMs:0).
    expect(typeof done.durationMs).toBe('number');
    // Default surface: no verbose body. The "Use --verbose…" footer hint is
    // emitted by the shared resultToView seam (ADR-0021), not carried on the
    // result — asserted in the cli result-to-view / golden tests.
    expect(done.verboseDetail).toBeUndefined();
  });

  it('produces a verbose RunPresentation carrying the report body as VerboseDetail', async () => {
    const { cli, setExitCode, render } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, verbose: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const done = render.mock.calls[0]?.[0] as RunPresentation;
    expect(done.type).toBe('run-presentation');
    expect(done.verboseDetail?.kind).toBe('lines');
    const body = done.verboseDetail?.kind === 'lines' ? done.verboseDetail.lines.join('\n') : '';
    expect(body).toContain('== Catalog ==');
    expect(body).toContain('== Findings');
    // The trailing "== Summary ==" block is suppressed (includeSummary:
    // false) — the shared summary line is rendered from the envelope verdict.
    expect(body).not.toContain('== Summary ==');
  });

  it('emits the signal envelope when --json is set', async () => {
    const { cli, setExitCode, emitEnvelope } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, json: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const envelope = emitEnvelope.mock.calls[0]?.[0] as { tool: string; schemaVersion: number };
    expect(envelope.tool).toBe('graph');
    expect(envelope.schemaVersion).toBe(2);
  });

  it('emits a configuration error when --gate-save and --gate-compare are both set', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateSave: true, gateCompare: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('mutually exclusive');
  });

  it('emits a configuration error when --workspace and positional paths are both set', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, paths: ['foo'], workspace: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('mutually exclusive');
  });

  it('--catalog-output without --tenant-id raises configuration error', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    const outPath = join(projectDir, 'catalog.json');
    await executeGraph(
      { cwd: projectDir, noCache: true, catalogOutput: outPath, repoId: 'r', gitSha: 'sha' },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('--tenant-id');
  });

  it('--catalog-output without --repo-id raises configuration error', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    const outPath = join(projectDir, 'catalog.json');
    await executeGraph(
      { cwd: projectDir, noCache: true, catalogOutput: outPath, tenantId: 't', gitSha: 'sha' },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('--repo-id');
  });

  it('--catalog-output without --git-sha raises configuration error', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    const outPath = join(projectDir, 'catalog.json');
    await executeGraph(
      { cwd: projectDir, noCache: true, catalogOutput: outPath, tenantId: 't', repoId: 'r' },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('--git-sha');
  });

  it('--catalog-output happy path writes a valid CatalogExport JSON file', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    const outPath = join(projectDir, 'catalog.json');
    await executeGraph(
      {
        cwd: projectDir,
        noCache: true,
        catalogOutput: outPath,
        tenantId: 'tenant_test',
        repoId: 'repo_test',
        gitSha: 'abc1234567890abc1234567890abc1234567890a',
        runId: 'run_test_fixed',
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(0);

    // Read written file + assert wire shape
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as {
      version: string;
      provenance: { runId: string; tenantId: string; completeness: string };
      symbols: { repoId: string; gitSha: string; qualifiedName: string }[];
      edges: unknown[];
    };
    expect(written.version).toBe('1.0');
    expect(written.provenance.runId).toBe('run_test_fixed');
    expect(written.provenance.tenantId).toBe('tenant_test');
    expect(written.provenance.completeness).toBe('complete');
    expect(written.symbols.length).toBeGreaterThan(0);
    for (const s of written.symbols) {
      expect(s.repoId).toBe('repo_test');
      expect(s.gitSha).toBe('abc1234567890abc1234567890abc1234567890a');
    }
  });

  it('--catalog-output creates the parent directory when the output path is nested', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    const outPath = join(projectDir, 'nested', 'deep', 'catalog.json');
    await executeGraph(
      {
        cwd: projectDir,
        noCache: true,
        catalogOutput: outPath,
        tenantId: 'tenant_test',
        repoId: 'repo_test',
        gitSha: 'abc1234567890abc1234567890abc1234567890a',
        runId: 'run_test_nested',
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(0);
    const written = JSON.parse(readFileSync(outPath, 'utf8')) as { version: string };
    expect(written.version).toBe('1.0');
  });
});

describe('executeGraph — gate modes', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    currentAdapterRegistry().register(fakeAdapter(projectDir));
  });

  afterEach(() => {
    datastore.close();
  });

  it('--gate-save persists the current signals as the baseline (host-owned exit 0)', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateSave: true }, cli);
    // The host derives the exit from the deliverSignals runFailed override; a
    // clean run maps to 0.
    expect(setExitCode).toHaveBeenCalledWith(0);
    expect(new BaselineRepo(datastore).exists('graph')).toBe(true);
  });

  it('--gate-compare PASS after a --gate-save with matching state', async () => {
    const { cli: saveCli } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateSave: true }, saveCli);
    const { cli, setExitCode, render } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateCompare: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    expect(renderedLines(render)).toContain('Graph gate PASS');
  });

  it('--gate-compare FAIL when current findings exceed baseline', async () => {
    // Seed an empty baseline so every current finding is net-new (degraded).
    new BaselineRepo(datastore).save('graph', []);
    const { cli, setExitCode, render } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateCompare: true }, cli);
    // degraded → the host runFailed override maps to RUNTIME_ERROR (1).
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(renderedLines(render)).toContain('Graph gate FAILED');
  });
});

describe('executeGraph — error handling', () => {
  it('reports a runtime error if pickAdapter fails (no adapter registered)', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(2);
    } finally {
      datastore.close();
    }
  });
});

describe('executeGraph — positional paths', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    currentAdapterRegistry().register(fakeAdapter(projectDir));
  });

  afterEach(() => {
    datastore.close();
  });

  it('errors when a positional path does not exist', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph(
      { cwd: projectDir, noCache: true, paths: [join(projectDir, 'missing-pkg')] },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('does not exist');
  });
});

describe('executeGraph — --workspace aggregation', () => {
  let workDir: string;
  let datastore: DataStore;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'graph-workspace-'));
    datastore = DataStoreFactory.open({ backend: 'memory' });
    currentAdapterRegistry().register(fakeAdapter(workDir));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    datastore.close();
  });

  it('errors with ConfigurationError when no workspace units exist', async () => {
    const fakeCliPath = join(workDir, 'cli.cjs');
    writeFileSync(fakeCliPath, 'process.exit(0);');
    const { cli, setExitCode } = mockCli(datastore, makeWorkspaceLangRegistry([]));
    // tsconfig present so detection picks up `typescript`; the adapter
    // returns [] so the workspace path errors with the D9 message.
    writeFileSync(join(workDir, 'tsconfig.json'), '{}');
    await executeGraph(
      {
        cwd: workDir,
        noCache: true,
        workspace: true,
        cliScript: fakeCliPath,
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it('errors when neither cliScript nor process.argv[1] is provided', async () => {
    const prev = process.argv[1];
    try {
      // Spoof process.argv[1] to empty so the handler hits the
      // "could not determine the CLI entry script" branch.
      process.argv[1] = '';
      const { cli, setExitCode } = mockCli(datastore, makeWorkspaceLangRegistry([]));
      await executeGraph({ cwd: workDir, noCache: true, workspace: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(2);
    } finally {
      process.argv[1] = prev ?? '';
    }
  });

  it('aggregates per-unit output and emits human report', async () => {
    const pkgA = join(workDir, 'packages', 'a');
    const pkgB = join(workDir, 'packages', 'b');
    mkdirSync(pkgA, { recursive: true });
    mkdirSync(pkgB, { recursive: true });
    const TSCONFIG = '{}';
    writeFileSync(join(pkgA, 'tsconfig.json'), TSCONFIG);
    writeFileSync(join(pkgB, 'tsconfig.json'), TSCONFIG);
    // Top-level marker so detection identifies the language.
    writeFileSync(join(workDir, 'tsconfig.json'), TSCONFIG);
    const fakeCliPath = join(workDir, 'cli.cjs');
    writeFileSync(
      fakeCliPath,
      `
const out = {
  version: '1.0', tool: 'graph', timestamp: new Date().toISOString(),
  recipe: 'graph', score: 100, passed: true,
  summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
  checks: [], durationMs: 0,
};
process.stdout.write(JSON.stringify(out));
process.exit(0);
`,
    );
    const units: WorkspaceUnit[] = [
      { id: 'a', rootDir: pkgA, configPath: join(pkgA, 'tsconfig.json') },
      { id: 'b', rootDir: pkgB, configPath: join(pkgB, 'tsconfig.json') },
    ];
    const { cli, setExitCode, render } = mockCli(datastore, makeWorkspaceLangRegistry(units));
    await executeGraph(
      {
        cwd: workDir,
        noCache: true,
        workspace: true,
        cliScript: fakeCliPath,
        concurrency: 1,
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(0);
    const out = renderedLines(render);
    expect(out).toContain('opensip graph --workspace');
    expect(out).toContain('== Units (2)');
  });

  it('emits JSON when --workspace + --json and surfaces failed children', async () => {
    const pkg = join(workDir, 'packages', 'a');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'tsconfig.json'), '{}');
    writeFileSync(join(workDir, 'tsconfig.json'), '{}');
    const fakeCliPath = join(workDir, 'cli.cjs');
    writeFileSync(
      fakeCliPath,
      String.raw`
process.stderr.write('boom\n');
process.exit(1);
`,
    );
    const units: WorkspaceUnit[] = [
      { id: 'a', rootDir: pkg, configPath: join(pkg, 'tsconfig.json') },
    ];
    const { cli, setExitCode, emitJson } = mockCli(datastore, makeWorkspaceLangRegistry(units));
    await executeGraph(
      {
        cwd: workDir,
        noCache: true,
        workspace: true,
        json: true,
        cliScript: fakeCliPath,
        concurrency: 1,
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(1);
    // ADR-0011: --workspace --json now emits the JSON document object through
    // the CLI seam (cli.emitJson), not process.stdout directly.
    expect(emitJson).toHaveBeenCalledTimes(1);
    const parsed = emitJson.mock.calls[0]?.[0] as { mode: string; totalFindings: number };
    expect(parsed.mode).toBe('workspace');
    expect(parsed.totalFindings).toBe(0);
  });
});

describe('executeGraph — report-to mode', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    currentAdapterRegistry().register(fakeAdapter(projectDir));
  });

  afterEach(() => {
    datastore.close();
  });

  it('sets a non-zero exit code when the cloud endpoint is unreachable', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph(
      {
        cwd: projectDir,
        noCache: true,
        reportTo: 'http://127.0.0.1:1', // unreachable port
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalled();
    const code = setExitCode.mock.calls[0]?.[0];
    expect(typeof code).toBe('number');
  });
});

describe('buildUnifiedReportLines', () => {
  it('renders catalog, findings, entry-points, and summary sections', () => {
    const lines = buildUnifiedReportLines({
      catalog: makeCatalog(),
      indexes: makeIndexes(),
      signals: [],
      cacheHit: true,
    });
    const text = lines.join('\n');
    expect(text).toContain('== Catalog ==');
    expect(text).toContain('functions across');
    expect(text).toContain('cacheHit=true');
    expect(text).toContain('== Findings (0)');
    expect(text).toContain('== Entry points');
    expect(text).toContain('== Summary ==');
    expect(text).toContain('rule(s) clean');
  });

  it('handles a null catalog gracefully (no entry-points section content)', () => {
    const lines = buildUnifiedReportLines({
      catalog: null,
      indexes: null,
      signals: [],
      cacheHit: false,
    });
    const text = lines.join('\n');
    expect(text).toContain('== Catalog ==');
    expect(text).toContain('== Entry points (0)');
    expect(text).toContain('(none inferred)');
  });

  it('groups findings under their rule headers', () => {
    const findings = [
      sig({ ruleId: 'graph:orphan-subtree', message: 'foo', filePath: 'src/a.ts', line: 1 }),
      sig({ ruleId: 'graph:orphan-subtree', message: 'bar', filePath: 'src/b.ts', line: 2 }),
      sig({
        ruleId: 'graph:duplicated-function-body',
        message: 'dup',
        filePath: 'src/c.ts',
        line: 3,
      }),
    ];
    const lines = buildUnifiedReportLines({
      catalog: makeCatalog(),
      indexes: makeIndexes(),
      signals: findings,
      cacheHit: false,
    });
    const text = lines.join('\n');
    expect(text).toContain('[graph:orphan-subtree] 2 finding(s)');
    expect(text).toContain('[graph:duplicated-function-body] 1 finding(s)');
    expect(text).toContain('src/a.ts:1');
    expect(text).toContain('src/c.ts:3');
  });
});
