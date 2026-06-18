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

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ConfigurationError, enterScope, LanguageRegistry } from '@opensip-cli/core';
import { BaselineRepo, DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { formatSignalSarif } from '@opensip-cli/output';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { currentAdapterRegistry } from '../lang-adapter/registry.js';
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
import type { CommandHandler, ToolCliContext } from '@opensip-cli/core';

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

/**
 * Mirror the real host `exportBaselineFingerprints` seam against the test
 * datastore: write the byte-identical fingerprint JSON, or throw the
 * missing-baseline ConfigurationError. Extracted so `makeMockCli` stays within
 * its cognitive-complexity budget.
 */
function writeFingerprintBaseline(
  datastore: DataStore | undefined,
  tool: string,
  path: string,
): void {
  const repo = new BaselineRepo(datastore!);
  if (!repo.exists(tool)) {
    throw new ConfigurationError(`No ${tool} baseline found in the project SQLite store.`, {
      code: 'CONFIGURATION.GATE.BASELINE_MISSING',
    });
  }
  const fingerprints = repo
    .load(tool)
    .map((r) => r.fingerprint)
    .sort((a, b) => a.localeCompare(b));
  const file = {
    version: '1',
    tool,
    capturedAt: new Date(repo.capturedAt(tool) ?? 0).toISOString(),
    fingerprints,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf8');
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
    maybeOpenReport: vi.fn(),
    logger: console,
    setExitCode,
    emitJson,
    emitRaw: vi.fn(),
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
    // ADR-0036 host baseline/ratchet seams. The fingerprint export mirrors the
    // real host seam against the test datastore (write JSON / throw on missing).
    saveBaseline: vi.fn().mockResolvedValue(undefined),
    compareBaseline: vi
      .fn()
      .mockResolvedValue({ added: [], resolved: [], unchanged: [], degraded: false }),
    exportBaselineSarif: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/require-await -- async to match the seam signature
    exportBaselineFingerprints: vi.fn(async (tool: string, path: string) =>
      writeFingerprintBaseline(datastore, tool, path),
    ),
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
      'graph-shard-worker',
      'graph-run-worker',
      // Canonical nested export spec — name 'export', parent 'graph'.
      'export',
      // Grouped Tier-2 children (the canonical `<tool> <verb>` grammar) — name
      // 'recipes' / 'lookup' / 'index' / 'list', parent 'graph'.
      'recipes',
      'lookup',
      'index',
      'list',
      'graph-equivalence-check',
    ]);
    // The legacy flat-root aliases are gone.
    expect(names).not.toContain('graph-lookup');
    expect(names).not.toContain('graph-symbol-index');
    expect(names).not.toContain('graph-baseline-export');
    expect(names).not.toContain('catalog-export');
    expect(names).not.toContain('sarif-export');
    expect(names).not.toContain('graph-recipes');
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

  describe('graph lookup handler (nested)', () => {
    it('routes to executeLookup with the given name', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        seedCatalog(datastore, [makeOcc({ simpleName: 'saveBaseline', bodyHash: 'h1' })]);
        const { cli, setExitCode, render } = makeMockCli(datastore);
        await handlerFor('lookup')({ _args: ['saveBaseline'] }, cli);
        expect(setExitCode).toHaveBeenCalledWith(0);
        // Human lookup output flows through the render seam, not stdout.
        expect(renderedLines(render)).toContain('saveBaseline');
      } finally {
        datastore.close();
      }
    });
  });

  describe('graph index handler (nested)', () => {
    it('routes to executeSymbolIndex with cwd + out flags', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        seedCatalog(datastore, [makeOcc({ simpleName: 'fn', bodyHash: 'h1' })]);
        const { cli, setExitCode } = makeMockCli(datastore);
        await handlerFor('index')({ cwd: workDir, out: 'idx.json', _args: [] }, cli);
        expect(setExitCode).toHaveBeenCalledWith(0);
      } finally {
        datastore.close();
      }
    });
  });

  // Canonical `graph export --format <fmt>` — the single export command (the
  // legacy flat-root `graph-baseline-export` / `catalog-export` / `sarif-export`
  // aliases were removed). The canonical spec dispatches on --format and
  // validates the per-format required flags.
  describe('graph export handler (canonical, --format dispatch)', () => {
    it('--format baseline exports the gate fingerprint JSON', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        new BaselineRepo(datastore).save('graph', []);
        const outPath = join(workDir, 'baseline.json');
        const { cli } = makeMockCli(datastore);
        await handlerFor('export')({ format: 'baseline', out: outPath, _args: [] }, cli);
        const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(out).toContain('Exported graph baseline');
      } finally {
        datastore.close();
      }
    });

    it('--format catalog runs the pipeline and writes the CatalogExport JSON', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const outPath = join(workDir, 'catalog.json');
        const { cli, setExitCode } = makeMockCli(datastore);
        await handlerFor('export')(
          {
            format: 'catalog',
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
      } finally {
        datastore.close();
      }
    });

    it('--format sarif runs the pipeline and writes a SARIF document', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        currentAdapterRegistry().register(fakeAdapter(workDir));
        const outPath = join(workDir, 'out.sarif');
        const { cli, setExitCode } = makeMockCli(datastore);
        await handlerFor('export')(
          {
            format: 'sarif',
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
      } finally {
        datastore.close();
      }
    });

    it('rejects a missing per-format required flag with exit 2 + stderr', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        const { cli, setExitCode } = makeMockCli(datastore);
        // --format sarif requires --output-sarif/--tenant-id/--repo-id; omit them.
        await handlerFor('export')({ format: 'sarif', cwd: workDir, _args: [] }, cli);
        expect(setExitCode).toHaveBeenCalledWith(2);
        const err = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(err).toContain('requires');
      } finally {
        datastore.close();
      }
    });

    it('emits a structured error when --json + missing required flag', async () => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      try {
        const { cli, emitError, setExitCode } = makeMockCli(datastore);
        await handlerFor('export')(
          { format: 'baseline', json: true, cwd: workDir, _args: [] },
          cli,
        );
        expect(setExitCode).toHaveBeenCalledWith(2);
        expect(emitError.mock.calls.length).toBe(1);
        const payload = emitError.mock.calls[0]?.[0] as { exitCode?: number };
        expect(payload?.exitCode).toBe(2);
      } finally {
        datastore.close();
      }
    });
  });
});
