/**
 * `executeGraph` dispatch branches: mutually-exclusive flag validation,
 * the verbose vs default vs JSON render paths, multi-path aggregation,
 * and the --workspace error guards (no CLI script, no detected units).
 * These exercise the synchronous dispatch logic in cli/graph.ts that the
 * narrower language-mismatch + tool-register suites don't reach.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, LanguageRegistry } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
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
    walkProject: (): WalkOutput => ({ occurrences: { fn: [occ()] }, callSites: [], parseErrors: [] }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map([['h1', []]]),
      stats: { totalCallSites: 0, resolvedHigh: 0, resolvedMedium: 0, resolvedLow: 0, unresolved: 0 },
    }),
    cacheKey: () => 'fake-v1',
  };
}

interface MockCliBag {
  readonly cli: ToolCliContext;
  readonly setExitCode: MockInstance;
}

function mockCli(datastore?: DataStore): MockCliBag {
  const setExitCode = vi.fn();
  return {
    cli: {
      setExitCode,
      emitJson: vi.fn(),
      scope: { datastore: () => datastore, languages: new LanguageRegistry() },
    } as unknown as ToolCliContext,
    setExitCode,
  };
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let projectDir: string;
let stdout = '';

beforeEach(() => {
  enterScope(makeGraphTestScope());
  projectDir = mkdtempSync(join(tmpdir(), 'graph-exec-'));
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'a.ts'), 'export const x = 1;\n', 'utf8');
  stdout = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    stdout += typeof c === 'string' ? c : c.toString();
    return true;
  });
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
    await executeGraph(
      { cwd: projectDir, noCache: true, gateSave: true, gateCompare: true },
      cli,
    );
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
  it('renders JSON to stdout under --json (exit 0)', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true, json: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      const parsed = JSON.parse(stdout) as { tool: string };
      expect(parsed.tool).toBe('graph');
    } finally {
      datastore.close();
    }
  });

  it('renders the verbose unified report and the plain one-line summary', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true, verbose: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      expect(stdout).toContain('== Catalog ==');
      expect(stdout).toContain('Passed');
    } finally {
      datastore.close();
    }
  });

  it('renders the default (non-verbose) summary + footer hints', async () => {
    currentAdapterRegistry().register(populatedAdapter());
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    try {
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      expect(stdout).toContain('Use --verbose for detailed results');
      expect(stdout).not.toContain('== Catalog ==');
    } finally {
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
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph(
        { cwd: projectDir, noCache: true, json: true, paths: [projectDir, other] },
        cli,
      );
      expect(setExitCode).toHaveBeenCalledWith(0);
      const parsed = JSON.parse(stdout) as { tool: string };
      expect(parsed.tool).toBe('graph');
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
      const { cli, setExitCode } = mockCli(datastore);
      await executeGraph({ cwd: projectDir, noCache: true, gateSave: true }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      expect(stdout).toContain('Graph baseline saved');
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
      expect(stdout).toContain('Graph gate PASS');
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
    await executeGraph(
      { cwd: projectDir, noCache: true, workspace: true, cliScript: '' },
      cli,
    );
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
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('not a registered adapter');
  });
});
