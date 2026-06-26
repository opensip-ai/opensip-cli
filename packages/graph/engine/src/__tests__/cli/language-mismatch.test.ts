/**
 * D14 mixed-mismatch policy tests.
 *
 * When `--language X` is set and the analyzed file count is zero, exit
 * with code 2 and the canonical error message. When at least one file
 * is discovered, the run completes normally. Auto-detection (no
 * `--language`) does NOT trigger the check.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, LanguageRegistry } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { executeGraph } from '../../cli/graph.js';
import { currentAdapterRegistry } from '../../lang-adapter/registry.js';
import { makeReportFailureMock } from '../report-failure-mock.js';
import { makeGraphTestScope } from '../test-utils/with-graph-scope.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type { ToolCliContext } from '@opensip-cli/core';

function emptyAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'typescript',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    // Returns NO files — D14 test: catalog ends up with zero entries.
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: projectDir,
      files: [],
    }),
    parseProject: (): ParseOutput => ({ project: { dummy: true }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {},
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
    cacheKey: () => 'fake-empty-v1',
  };
}

function populatedAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'typescript',
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
    cacheKey: () => 'fake-populated-v1',
  };
}

interface MockCli {
  readonly cli: ToolCliContext;
  readonly setExitCode: MockInstance;
}

function mockCli(datastore: DataStore | undefined): MockCli {
  const setExitCode = vi.fn();
  const render = vi.fn(() => Promise.resolve());
  return {
    cli: {
      datastore,
      setExitCode,
      render,
      scope: { datastore: () => datastore, languages: new LanguageRegistry() },
      reportFailure: makeReportFailureMock(setExitCode, render),
    } as unknown as ToolCliContext,
    setExitCode,
  };
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let projectDir: string;
let datastore: DataStore;

beforeEach(() => {
  enterScope(makeGraphTestScope());
  projectDir = mkdtempSync(join(tmpdir(), 'graph-d14-'));
  datastore = DataStoreFactory.open({ backend: 'memory' });
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  currentAdapterRegistry().clear();
  datastore.close();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(projectDir, { recursive: true, force: true });
});

describe('D14 — --language with zero matching files', () => {
  it('exits 2 with the canonical error message', async () => {
    currentAdapterRegistry().register(emptyAdapter(projectDir));
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, language: 'typescript' }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    const err = (cli.render as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => (c[0] as { message?: string }).message ?? '')
      .join('\n');
    expect(err).toContain('--language typescript matched 0 files');
    expect(err).toContain('check the flag or paths');
  });

  it('does NOT trigger when --language is unset (auto-detect path)', async () => {
    currentAdapterRegistry().register(emptyAdapter(projectDir));
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true }, cli);
    // Zero files + no --language is a valid (non-error) state.
    expect(setExitCode).toHaveBeenCalledWith(0);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).not.toContain('matched 0 files');
  });

  it('exits 0 when --language is set and ≥1 file matches', async () => {
    currentAdapterRegistry().register(populatedAdapter(projectDir));
    const { cli, setExitCode } = mockCli(datastore);
    await executeGraph({ cwd: projectDir, noCache: true, language: 'typescript' }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(err).not.toContain('matched 0 files');
  });
});
