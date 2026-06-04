/**
 * Tests for `graphTool.register(cli)` — verifies that the Commander
 * subcommands wire up and the action handlers do the right thing
 * when invoked. We drive register() with a real `commander.Command`
 * instance so the option-parsing layer is exercised end-to-end.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { enterScope, LanguageRegistry } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { formatSignalSarif } from '@opensip-tools/output';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { saveBaseline } from '../gate.js';
import { currentAdapterRegistry } from '../lang-adapter/registry.js';
import { GraphBaselineRepo } from '../persistence/baseline-repo.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { graphTool } from '../tool.js';

import { makeGraphTestScope } from './test-utils/with-graph-scope.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../lang-adapter/types.js';
import type { Catalog, FunctionOccurrence } from '../types.js';
import type { ToolCliContext } from '@opensip-tools/core';

function fakeAdapter(projectDir: string): GraphLanguageAdapter {
  return {
    id: 'fake',
    fileExtensions: ['.ts'],
    displayName: 'Fake',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: projectDir,
      files: [join(projectDir, 'src', 'a.ts')],
    }),
    parseProject: (): ParseOutput => ({ project: { x: 1 }, parseErrors: [] }),
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
    cacheKey: () => 'fake-v1',
  };
}

function makeOcc(over: Partial<FunctionOccurrence> = {}): FunctionOccurrence {
  return {
    bodyHash: 'h1',
    bodySize: 100,
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
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

function seedCatalog(datastore: DataStore, occs: readonly FunctionOccurrence[]): void {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    let bucket = functions[o.simpleName];
    if (!bucket) {
      bucket = [];
      functions[o.simpleName] = bucket;
    }
    bucket.push(o);
  }
  const catalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'now',
    cacheKey: 'k',
    functions,
  };
  new CatalogRepo(datastore).replaceAll(catalog);
}

interface MockCliBag {
  readonly cli: ToolCliContext;
  readonly program: Command;
  readonly setExitCode: MockInstance;
  readonly emitJson: MockInstance;
  readonly registerLiveView: MockInstance;
  readonly renderLive: MockInstance;
  readonly render: MockInstance;
}

function makeMockCli(datastore?: DataStore): MockCliBag {
  const program = new Command();
  const setExitCode = vi.fn();
  const emitJson = vi.fn();
  const registerLiveView = vi.fn();
  const renderLive = vi.fn().mockResolvedValue(undefined);
  const render = vi.fn().mockResolvedValue(undefined);
  const cli = {
    program,
    project: { scope: 'none' },
    render,
    registerLiveView,
    renderLive,
    maybeOpenDashboard: vi.fn(),
    logger: console,
    setExitCode,
    emitJson,
    emitEnvelope: vi.fn(),
    deliverSignals: vi.fn().mockResolvedValue(undefined),
    // Root-owned SARIF-file sink (ADR-0011): mirror the composition root —
    // format the envelope through the shared formatter and write it.
    // eslint-disable-next-line @typescript-eslint/require-await -- async to match the seam signature
    writeSarif: vi.fn(async (envelope: unknown, path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, formatSignalSarif(envelope as Parameters<typeof formatSignalSarif>[0]));
    }),
    datastore,
    scope: { datastore: () => datastore, languages: new LanguageRegistry() },
  } as unknown as ToolCliContext;
  return { cli, program, setExitCode, emitJson, registerLiveView, renderLive, render };
}

/** Concatenated text of every lines-bearing result handed to cli.render(). */
function renderedLines(render: MockInstance): string {
  return (render.mock.calls as unknown as readonly [{ lines?: readonly string[] }][])
    .map((c) => c[0].lines?.join('\n') ?? '')
    .join('\n');
}

let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let workDir: string;

beforeEach(() => {
  // Item 1: graph adapter + rule registries are per-RunScope.
  enterScope(makeGraphTestScope());
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  workDir = mkdtempSync(join(tmpdir(), 'tool-reg-'));
});

afterEach(() => {
  currentAdapterRegistry().clear();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(workDir, { recursive: true, force: true });
});

describe('graphTool.register', () => {
  it('mounts all subcommands on the program', () => {
    const { cli, program } = makeMockCli();
    graphTool.register(cli);
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual([
      'graph',
      'graph-lookup',
      'graph-shard-worker',
      'graph-symbol-index',
      'graph-baseline-export',
      'catalog-export',
      'sarif-export',
      'graph-recipes',
    ]);
  });

  it('registers a live-view renderer under the "graph" key', () => {
    const { cli, registerLiveView } = makeMockCli();
    graphTool.register(cli);
    const calls = registerLiveView.mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]).toBe('graph');
    expect(typeof calls[0]?.[1]).toBe('function');
  });

  describe('graph subcommand action', () => {
    it('positional path bypasses the live view and routes through executeGraph', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const { cli, program, renderLive, setExitCode } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(
          ['graph', '--json', join(workDir, 'missing')],
          { from: 'user' },
        );
        // Positional path skips heap-preflight and routes to executeGraph
        // (not the Ink live view).
        expect(renderLive.mock.calls.length).toBe(0);
        // The path doesn't exist on disk → exit 2.
        expect(setExitCode.mock.calls.length).toBeGreaterThan(0);
      } finally {
        datastore.close();
      }
    });

    it('default interactive path routes through cli.renderLive', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const { cli, program, renderLive } = makeMockCli(datastore);
        graphTool.register(cli);
        // Set the sentinel so heap-preflight short-circuits without
        // touching the file system.
        const prev = process.env.OPENSIP_HEAP_ELEVATED;
        process.env.OPENSIP_HEAP_ELEVATED = '1';
        // The animated live view is taken only on a TTY; vitest's stdout is
        // not a TTY, so force it for this assertion.
        const prevTTY = process.stdout.isTTY;
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        try {
          await program.parseAsync(['graph'], { from: 'user' });
        } finally {
          if (prev === undefined) delete process.env.OPENSIP_HEAP_ELEVATED;
          else process.env.OPENSIP_HEAP_ELEVATED = prev;
          Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
        }
        expect(renderLive.mock.calls.length).toBe(1);
        expect(renderLive.mock.calls[0]?.[0]).toBe('graph');
      } finally {
        datastore.close();
      }
    });
  });

  describe('graph-lookup subcommand action', () => {
    it('routes to executeLookup with the given name', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        seedCatalog(datastore, [makeOcc({ simpleName: 'saveBaseline', bodyHash: 'h1' })]);
        const { cli, program, setExitCode, render } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(['graph-lookup', 'saveBaseline'], { from: 'user' });
        expect(setExitCode).toHaveBeenCalledWith(0);
        // Human lookup output flows through the render seam, not stdout.
        expect(renderedLines(render)).toContain('saveBaseline');
      } finally {
        datastore.close();
      }
    });
  });

  describe('graph-symbol-index subcommand action', () => {
    it('routes to executeSymbolIndex with cwd + out flags', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        seedCatalog(datastore, [makeOcc({ simpleName: 'fn', bodyHash: 'h1' })]);
        const { cli, program, setExitCode } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(
          ['graph-symbol-index', '--cwd', workDir, '--out', 'idx.json'],
          { from: 'user' },
        );
        expect(setExitCode).toHaveBeenCalledWith(0);
      } finally {
        datastore.close();
      }
    });
  });

  describe('graph-baseline-export subcommand action', () => {
    it('exports baseline to disk on success', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        saveBaseline([], new GraphBaselineRepo(datastore));
        const outPath = join(workDir, 'baseline.json');
        const { cli, program } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(
          ['graph-baseline-export', '--out', outPath],
          { from: 'user' },
        );
        const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(out).toContain('Exported graph baseline');
      } finally {
        datastore.close();
      }
    });

    it('emits structured JSON when --json + success', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        saveBaseline([], new GraphBaselineRepo(datastore));
        const outPath = join(workDir, 'baseline.json');
        const { cli, program, emitJson } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(
          ['graph-baseline-export', '--out', outPath, '--json'],
          { from: 'user' },
        );
        expect(emitJson.mock.calls.length).toBe(1);
        const payload = emitJson.mock.calls[0]?.[0] as { type?: string };
        expect(payload?.type).toBe('graph-baseline-export');
      } finally {
        datastore.close();
      }
    });

    it('writes a human error to stderr when no baseline has been captured', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        const outPath = join(workDir, 'baseline.json');
        const { cli, program, setExitCode } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(
          ['graph-baseline-export', '--out', outPath],
          { from: 'user' },
        );
        expect(setExitCode).toHaveBeenCalledWith(2);
        const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(err).toContain('Error');
      } finally {
        datastore.close();
      }
    });

    it('emits structured JSON error when --json + missing baseline', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        const outPath = join(workDir, 'baseline.json');
        const { cli, program, emitJson, setExitCode } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(
          ['graph-baseline-export', '--out', outPath, '--json'],
          { from: 'user' },
        );
        expect(setExitCode).toHaveBeenCalledWith(2);
        expect(emitJson.mock.calls.length).toBe(1);
        const payload = emitJson.mock.calls[0]?.[0] as { error?: string };
        expect(payload?.error).toContain('No graph baseline');
      } finally {
        datastore.close();
      }
    });
  });

  describe('catalog-export subcommand action', () => {
    it('runs the pipeline and routes through runCatalogJsonMode', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const outPath = join(workDir, 'catalog.json');
        const { cli, program, setExitCode } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(
          [
            'catalog-export',
            '--catalog-output', outPath,
            '--tenant-id', 't1',
            '--repo-id', 'r1',
            '--git-sha', 'abc123',
            '--run-id', 'run-1',
            '--cwd', workDir,
          ],
          { from: 'user' },
        );
        expect(setExitCode).toHaveBeenCalledWith(0);
        expect(existsSync(outPath)).toBe(true);
        const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as {
          version?: string;
          provenance?: { runId?: string; tenantId?: string; completeness?: string };
        };
        expect(parsed.version).toBe('1.0');
        expect(parsed.provenance?.runId).toBe('run-1');
        expect(parsed.provenance?.tenantId).toBe('t1');
        expect(parsed.provenance?.completeness).toBe('complete');
      } finally {
        datastore.close();
      }
    });
  });

  describe('sarif-export subcommand action', () => {
    it('runs the pipeline and writes a SARIF v2.1.0 document to the output path', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const outPath = join(workDir, 'out.sarif');
        const { cli, program, setExitCode } = makeMockCli(datastore);
        graphTool.register(cli);
        await program.parseAsync(
          [
            'sarif-export',
            '--output-sarif', outPath,
            '--tenant-id', 't1',
            '--repo-id', 'r1',
            '--cwd', workDir,
          ],
          { from: 'user' },
        );
        expect(setExitCode).toHaveBeenCalledWith(0);
        expect(existsSync(outPath)).toBe(true);
        const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as { version?: string };
        expect(parsed.version).toBe('2.1.0');
      } finally {
        datastore.close();
      }
    });
  });
});
