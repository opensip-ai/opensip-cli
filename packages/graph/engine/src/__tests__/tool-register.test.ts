/**
 * Tests for graph's command-spec handlers — verifies that each declarative
 * `CommandSpec` handler does the right thing when the host invokes it after
 * parsing.
 *
 * Since release 2.11.0 Phase 5 graph mounts via `commandSpecs`, not the
 * deprecated `register()` hook. The host-owned mount path (Commander wiring,
 * `_args` positional convention, output dispatch) is covered in
 * `cli/src/__tests__/mount-command-spec.test.ts`; here we drive each spec's
 * handler directly with a fake ToolCliContext (the handler is exactly what the
 * host invokes post-parse). Positional arguments are threaded the way the host
 * threads them: on the parsed-opts object under the `_args` key. For graph's
 * sole variadic positional (`[paths...]`), `_args[0]` is the paths array.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { enterScope, LanguageRegistry } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { formatSignalSarif } from '@opensip-tools/output';
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
import type { CommandHandler, ToolCliContext } from '@opensip-tools/core';

/**
 * Resolve a graph command-spec handler by command name. Mirrors how the host
 * invokes a handler: `handler(opts, ctx)`, where positionals ride on `opts._args`.
 */
function handlerFor(name: string): CommandHandler<unknown, ToolCliContext> {
  const spec = (graphTool.commandSpecs ?? []).find((s) => s.name === name);
  if (spec === undefined) throw new Error(`graphTool exposes no command spec '${name}'`);
  return spec.handler;
}

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
  readonly setExitCode: MockInstance;
  readonly emitJson: MockInstance;
  readonly emitError: MockInstance;
  readonly registerLiveView: MockInstance;
  readonly renderLive: MockInstance;
  readonly render: MockInstance;
}

function makeMockCli(datastore?: DataStore): MockCliBag {
  const setExitCode = vi.fn();
  const emitJson = vi.fn();
  // 2.12.0: the structured-error seam mirrors the host — it sets the exit code.
  const emitError = vi.fn((detail: { exitCode: number }) => setExitCode(detail.exitCode));
  const registerLiveView = vi.fn();
  const renderLive = vi.fn().mockResolvedValue(undefined);
  const render = vi.fn().mockResolvedValue(undefined);
  const cli = {
    project: { scope: 'none' },
    render,
    registerLiveView,
    renderLive,
    maybeOpenDashboard: vi.fn(),
    logger: console,
    setExitCode,
    emitJson,
    emitEnvelope: vi.fn(),
    emitError,
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
  return { cli, setExitCode, emitJson, emitError, registerLiveView, renderLive, render };
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

describe('graphTool command surface', () => {
  it('declares one spec per command, in mount order', () => {
    const names = (graphTool.commandSpecs ?? []).map((s) => s.name);
    expect(names).toEqual([
      'graph',
      'graph-lookup',
      'graph-shard-worker',
      'graph-run-worker',
      'graph-symbol-index',
      'graph-baseline-export',
      'catalog-export',
      'sarif-export',
      'graph-recipes',
    ]);
  });

  describe('graph handler', () => {
    it('positional path bypasses the live view and routes through executeGraph', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const { cli, renderLive, setExitCode } = makeMockCli(datastore);
        // `_args[0]` carries the variadic [paths...] array (host convention).
        await handlerFor('graph')(
          { cwd: workDir, json: true, _args: [[join(workDir, 'missing')]] },
          cli,
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

    it('interactive --exact path registers + routes through cli.renderLive', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const { cli, renderLive, registerLiveView } = makeMockCli(datastore);
        // Set the sentinel so heap-preflight short-circuits without
        // touching the file system.
        const prev = process.env.OPENSIP_HEAP_ELEVATED;
        process.env.OPENSIP_HEAP_ELEVATED = '1';
        // The animated live view is taken only on a TTY; vitest's stdout is
        // not a TTY, so force it for this assertion.
        const prevTTY = process.stdout.isTTY;
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        try {
          // The Ink live runner drives the EXACT single-program engine, so it is
          // eligible only under `--exact` (ADR-0032: sharded is the default and
          // routes to the static path). No positionals: `_args` is the empty
          // variadic array.
          await handlerFor('graph')({ cwd: workDir, exact: true, _args: [[]] }, cli);
        } finally {
          if (prev === undefined) delete process.env.OPENSIP_HEAP_ELEVATED;
          else process.env.OPENSIP_HEAP_ELEVATED = prev;
          Object.defineProperty(process.stdout, 'isTTY', { value: prevTTY, configurable: true });
        }
        // Spec-mounted world: the renderer is set up lazily on the interactive
        // path before the renderLive lookup.
        expect(registerLiveView.mock.calls[0]?.[0]).toBe('graph');
        expect(renderLive.mock.calls.length).toBe(1);
        expect(renderLive.mock.calls[0]?.[0]).toBe('graph');
      } finally {
        datastore.close();
      }
    });
  });

  describe('graph-lookup handler', () => {
    it('routes to executeLookup with the given name', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        seedCatalog(datastore, [makeOcc({ simpleName: 'saveBaseline', bodyHash: 'h1' })]);
        const { cli, setExitCode, render } = makeMockCli(datastore);
        await handlerFor('graph-lookup')({ _args: ['saveBaseline'] }, cli);
        expect(setExitCode).toHaveBeenCalledWith(0);
        // Human lookup output flows through the render seam, not stdout.
        expect(renderedLines(render)).toContain('saveBaseline');
      } finally {
        datastore.close();
      }
    });
  });

  describe('graph-symbol-index handler', () => {
    it('routes to executeSymbolIndex with cwd + out flags', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        seedCatalog(datastore, [makeOcc({ simpleName: 'fn', bodyHash: 'h1' })]);
        const { cli, setExitCode } = makeMockCli(datastore);
        await handlerFor('graph-symbol-index')({ cwd: workDir, out: 'idx.json', _args: [] }, cli);
        expect(setExitCode).toHaveBeenCalledWith(0);
      } finally {
        datastore.close();
      }
    });
  });

  describe('graph-baseline-export handler', () => {
    it('exports baseline to disk on success', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        saveBaseline([], new GraphBaselineRepo(datastore));
        const outPath = join(workDir, 'baseline.json');
        const { cli } = makeMockCli(datastore);
        await handlerFor('graph-baseline-export')({ out: outPath, _args: [] }, cli);
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
        const { cli, emitJson } = makeMockCli(datastore);
        await handlerFor('graph-baseline-export')({ out: outPath, json: true, _args: [] }, cli);
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
        const { cli, setExitCode } = makeMockCli(datastore);
        await handlerFor('graph-baseline-export')({ out: outPath, _args: [] }, cli);
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
        const { cli, emitError, setExitCode } = makeMockCli(datastore);
        await handlerFor('graph-baseline-export')({ out: outPath, json: true, _args: [] }, cli);
        expect(setExitCode).toHaveBeenCalledWith(2);
        // 2.12.0 (§5.5): a failed --json run emits a structured error through the
        // `emitError` seam (host wraps it in a status:'error' CommandOutcome),
        // not a bare `emitJson({ error })`.
        expect(emitError.mock.calls.length).toBe(1);
        const payload = emitError.mock.calls[0]?.[0] as { message?: string; exitCode?: number };
        expect(payload?.message).toContain('No graph baseline');
        expect(payload?.exitCode).toBe(2);
      } finally {
        datastore.close();
      }
    });
  });

  describe('catalog-export handler', () => {
    it('runs the pipeline and routes through runCatalogJsonMode', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const outPath = join(workDir, 'catalog.json');
        const { cli, setExitCode } = makeMockCli(datastore);
        await handlerFor('catalog-export')(
          {
            catalogOutput: outPath,
            tenantId: 't1',
            repoId: 'r1',
            gitSha: 'abc123',
            runId: 'run-1',
            cwd: workDir,
            mode: 'initial',
            resolution: 'exact',
            _args: [],
          },
          cli,
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

  describe('sarif-export handler', () => {
    it('runs the pipeline and writes a SARIF v2.1.0 document to the output path', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const outPath = join(workDir, 'out.sarif');
        const { cli, setExitCode } = makeMockCli(datastore);
        await handlerFor('sarif-export')(
          {
            outputSarif: outPath,
            tenantId: 't1',
            repoId: 'r1',
            cwd: workDir,
            resolution: 'exact',
            _args: [],
          },
          cli,
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
