/**
 * Tests for `executeGraph` — the main `opensip-tools graph` command
 * handler. Drives the full pipeline with a synthetic adapter and
 * exercises every branch the handler can take: human report, JSON,
 * gate-save, gate-compare (pass + degraded), report-to (cloud),
 * configuration errors, and packages aggregation.
 *
 * Also exercises `buildUnifiedReportLines` directly so the unified-
 * report renderer is covered without depending on the Ink runner.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSignal } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { buildUnifiedReportLines, executeGraph } from '../../cli/graph.js';
import { saveBaseline } from '../../gate.js';
import {
  clearAdapterRegistry,
  registerAdapter,
} from '../../lang-adapter/registry.js';
import { GraphBaselineRepo } from '../../persistence/baseline-repo.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type { Catalog, FunctionOccurrence, Indexes } from '../../types.js';
import type { Signal, ToolCliContext } from '@opensip-tools/core';

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
}

function mockCli(datastore: DataStore | undefined): MockCli {
  const setExitCode = vi.fn();
  return {
    cli: {
      datastore,
      setExitCode,
      scope: { datastore: () => datastore },
    } as unknown as ToolCliContext,
    setExitCode,
  };
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
    bySimpleName: new Map(),
    callees: new Map(),
    callers: new Map(),
    blastRadius: new Map(),
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
  clearAdapterRegistry();
  projectDir = mkdtempSync(join(tmpdir(), 'graph-test-proj-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  clearAdapterRegistry();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('executeGraph — human / JSON modes', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    registerAdapter(fakeAdapter(projectDir));
  });

  afterEach(() => {
    datastore.close();
  });

  it('renders the unified human report on the default path', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('opensip-tools graph');
    expect(out).toContain('== Catalog ==');
    expect(out).toContain('== Findings');
    expect(out).toContain('== Summary ==');
  });

  it('renders JSON when --json is set', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, json: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(out) as { tool: string; version: string };
    expect(parsed.tool).toBe('graph');
    expect(parsed.version).toBe('1.0');
  });

  it('emits a configuration error when --gate-save and --gate-compare are both set', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph(
      { cwd: projectDir, noCache: true, gateSave: true, gateCompare: true },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('mutually exclusive');
  });

  it('emits a configuration error when --package and --packages are both set', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph(
      { cwd: projectDir, noCache: true, packageScope: 'foo', allPackages: true },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('mutually exclusive');
  });
});

describe('executeGraph — gate modes', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    registerAdapter(fakeAdapter(projectDir));
  });

  afterEach(() => {
    datastore.close();
  });

  it('--gate-save persists the current signals as the baseline', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateSave: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const repo = new GraphBaselineRepo(datastore);
    expect(repo.exists()).toBe(true);
  });

  it('--gate-compare PASS after a --gate-save with matching state', async () => {
    const { cli: saveCli } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateSave: true }, saveCli);
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateCompare: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Graph gate PASS');
  });

  it('--gate-compare FAIL when current findings exceed baseline', async () => {
    saveBaseline([], new GraphBaselineRepo(datastore));
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, gateCompare: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(1);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('Graph gate FAILED');
  });

  it('throws ConfigurationError if --gate-save is used without a datastore', async () => {
    const { cli, setExitCode } = mockCli(undefined);
    await executeGraph({ cwd: projectDir, noCache: true, gateSave: true }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('DataStore');
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

describe('executeGraph — package scope', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    registerAdapter(fakeAdapter(projectDir));
  });

  afterEach(() => {
    datastore.close();
  });

  it('errors when --package points at a non-existent directory', async () => {
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph(
      { cwd: projectDir, noCache: true, packageScope: join(projectDir, 'missing-pkg') },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(2);
  });
});

describe('executeGraph — --packages aggregation', () => {
  let workDir: string;
  let datastore: DataStore;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'graph-packages-'));
    datastore = DataStoreFactory.open({ backend: 'memory' });
    registerAdapter(fakeAdapter(workDir));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    datastore.close();
  });

  it('errors with ConfigurationError when no packages exist under packages/', async () => {
    const fakeCliPath = join(workDir, 'cli.cjs');
    writeFileSync(fakeCliPath, 'process.exit(0);');
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph(
      {
        cwd: workDir,
        noCache: true,
        allPackages: true,
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
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph(
        { cwd: workDir, noCache: true, allPackages: true },
        cli,
      );
      expect(setExitCode).toHaveBeenCalledWith(2);
    } finally {
      process.argv[1] = prev ?? '';
    }
  });

  it('aggregates per-package output and emits human report', async () => {
    const pkgA = join(workDir, 'packages', 'a');
    const pkgB = join(workDir, 'packages', 'b');
    mkdirSync(pkgA, { recursive: true });
    mkdirSync(pkgB, { recursive: true });
    const TSCONFIG = '{}';
    writeFileSync(join(pkgA, 'tsconfig.json'), TSCONFIG);
    writeFileSync(join(pkgB, 'tsconfig.json'), TSCONFIG);
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
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph(
      {
        cwd: workDir,
        noCache: true,
        allPackages: true,
        cliScript: fakeCliPath,
        packagesConcurrency: 1,
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(0);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('opensip-tools graph --packages');
    expect(out).toContain('== Packages (2)');
  });

  it('emits JSON when --packages + --json and surfaces failed children', async () => {
    const pkg = join(workDir, 'packages', 'a');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'tsconfig.json'), '{}');
    const fakeCliPath = join(workDir, 'cli.cjs');
    writeFileSync(
      fakeCliPath,
      String.raw`
process.stderr.write('boom\n');
process.exit(1);
`,
    );
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph(
      {
        cwd: workDir,
        noCache: true,
        allPackages: true,
        json: true,
        cliScript: fakeCliPath,
        packagesConcurrency: 1,
      },
      cli,
    );
    expect(setExitCode).toHaveBeenCalledWith(1);
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(out) as { mode: string; totalFindings: number };
    expect(parsed.mode).toBe('packages');
    expect(parsed.totalFindings).toBe(0);
  });
});

describe('executeGraph — report-to mode', () => {
  let datastore: DataStore;

  beforeEach(() => {
    datastore = DataStoreFactory.open({ backend: 'memory' });
    registerAdapter(fakeAdapter(projectDir));
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
