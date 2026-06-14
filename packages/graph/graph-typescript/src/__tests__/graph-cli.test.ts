/**
 * Tests for the executeGraph CLI handler.
 *
 * The handler is a façade that wires runGraph to one of three modes
 * (table, JSON, gate, report) plus error mapping. We exercise stdout
 * capture and the various flag combinations against fixture projects.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LanguageRegistry, RunScope, runWithScope, runWithScopeSync } from '@opensip-cli/core';
import { BaselineRepo, DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { currentAdapterRegistry, graphTool } from '@opensip-cli/graph';
import { executeGraph } from '@opensip-cli/graph/internal';
import { typescriptAdapter } from '@opensip-cli/lang-typescript';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import type { Signal, ToolCliContext } from '@opensip-cli/core';

/** Minimal structural view of GraphDoneResult — avoids a contracts dep in this adapter test. */
interface GraphDoneLike {
  readonly type: string;
  readonly verboseDetail?:
    | { readonly kind: 'lines'; readonly lines: readonly string[] }
    | { readonly kind: 'findings'; readonly groups: readonly unknown[] };
  readonly summary: { readonly passed: number };
}

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'Node16',
    moduleResolution: 'Node16',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    rootDir: '.',
  },
  include: ['**/*.ts'],
});

function setupFixture(dir: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(p.slice(0, Math.max(0, p.lastIndexOf('/'))), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
}

function makeGraphScope(input: {
  readonly project: ToolCliContext['scope']['projectContext'];
  readonly datastore?: DataStore;
  readonly languages?: LanguageRegistry;
}): RunScope {
  const scope = new RunScope({
    projectContext: input.project,
    ...(input.datastore ? { datastore: () => input.datastore } : {}),
    ...(input.languages ? { languages: input.languages } : {}),
  });
  Object.assign(scope, graphTool.contributeScope?.() ?? {});
  runWithScopeSync(scope, () => currentAdapterRegistry().register(typescriptGraphAdapter));
  return scope;
}

interface CapturedCli {
  readonly cli: ToolCliContext;
  readonly exitCodes: number[];
  readonly datastore: DataStore;
  /** Captures the CommandResult(s) executeGraph hands to cli.render(). */
  readonly render: MockInstance;
}

function makeCli(): CapturedCli {
  const exitCodes: number[] = [];
  const render = vi.fn(() => Promise.resolve());
  const datastore = DataStoreFactory.open({ backend: 'memory' });
  const project = {
    cwd: '/test',
    cwdExplicit: false,
    projectRoot: '/test',
    configPath: undefined,
    walkedUp: 0,
    scope: 'none' as const,
  };
  const languages = new LanguageRegistry();
  // Register the real TS adapter so workspace detection (Phase 2)
  // matches `tsconfig.json` markers and workspace fan-out (Phase 3)
  // can call `discoverWorkspaceUnits`.
  languages.register(typescriptAdapter);
  const scope = makeGraphScope({ project, datastore, languages });
  const cli: ToolCliContext = {
    scope,
    render,
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    setExitCode: (c: number) => {
      exitCodes.push(c);
    },
    // Mirror the composition root's `emitJson` seam (cli-context.ts):
    // JSON.stringify(_, null, 2) + '\n' to stdout, so the `--workspace --json`
    // integration test can parse the emitted document (ADR-0011).
    emitJson: vi.fn((value: unknown) => {
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    }),
    // Mirror the composition root's `emitEnvelope` seam: write the envelope as
    // JSON to stdout so the `--json` integration test can parse it.
    emitError: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn((envelope: unknown) => {
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    }),
    // ADR-0036: the host owns the baseline seams + the gate exit. Mirror the real
    // host seams against the test datastore, and map the deliverSignals runFailed
    // override to setExitCode exactly as the host's deliver-envelope does.
    deliverSignals: vi.fn((_e: unknown, opts?: { runFailed?: boolean }) => {
      exitCodes.push(opts?.runFailed === true ? 1 : 0);
      return Promise.resolve({ cloudAccepted: 0 });
    }),
    writeSarif: vi.fn(() => Promise.resolve()),
    saveBaseline: vi.fn((tool: string, env: unknown) => {
      const signals = (env as { signals: readonly Signal[] }).signals;
      new BaselineRepo(datastore).save(
        tool,
        signals.map((s) => ({ fingerprint: s.fingerprint ?? '', payload: s })),
      );
      return Promise.resolve();
    }),
    compareBaseline: vi.fn((tool: string, env: unknown) => {
      const baseFps = new Set(new BaselineRepo(datastore).load(tool).map((r) => r.fingerprint));
      const added = (env as { signals: readonly Signal[] }).signals.filter(
        (s) => !baseFps.has(s.fingerprint ?? ''),
      );
      return Promise.resolve({ added, resolved: [], unchanged: [], degraded: added.length > 0 });
    }),
    exportBaselineSarif: vi.fn(() => Promise.resolve()),
    exportBaselineFingerprints: vi.fn(() => Promise.resolve()),
    toolState: {
      get: () => Promise.resolve(undefined),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
    },
    runSession: {
      timing: {
        startedAt: new Date().toISOString(),
        startedAtEpochMs: Date.now(),
        elapsedMs: () => 0,
        snapshot: () => ({ startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 0 }),
      },
      record: () => undefined,
    },
  };
  return { cli, exitCodes, datastore, render };
}

async function runExecuteGraph(
  options: Parameters<typeof executeGraph>[0],
  cli: ToolCliContext,
): Promise<Awaited<ReturnType<typeof executeGraph>>> {
  return runWithScope(cli.scope as RunScope, () => executeGraph(options, cli));
}

/**
 * Concatenated text of every `gate-done` / `graph-status` result handed to
 * cli.render() — gate, report, and workspace human output flow through the
 * render seam rather than direct stdout writes.
 */
function renderedLines(render: MockInstance): string {
  return (render.mock.calls as unknown as readonly [{ lines?: readonly string[] }][])
    .map((c) => c[0].lines?.join('\n') ?? '')
    .join('\n');
}

describe('executeGraph', () => {
  let dir: string;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  let stdout: string;
  let stderr: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-cli-'));
    stdout = '';
    stderr = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('default mode produces a graph-done result with summary + footer hint (no detailed body)', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const { cli, exitCodes, render } = makeCli();
    await runExecuteGraph({ cwd: dir }, cli);
    // executeGraph hands a structured result to the render seam; the
    // Ink-vs-plain-text rendering is the CLI's concern (covered there).
    const done = render.mock.calls[0]?.[0] as GraphDoneLike;
    expect(done.type).toBe('graph-done');
    expect(typeof done.summary.passed).toBe('number');
    // Non-verbose: no verbose body; the "Use --verbose…" footer is emitted by
    // the shared resultToView seam (ADR-0021), not carried on the result.
    expect(done.verboseDetail).toBeUndefined();
    expect(exitCodes).toContain(0);
  });

  it('--verbose mode produces a graph-done result with the detailed report body', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const { cli, exitCodes, render } = makeCli();
    await runExecuteGraph({ cwd: dir, verbose: true }, cli);
    const done = render.mock.calls[0]?.[0] as GraphDoneLike;
    expect(done.type).toBe('graph-done');
    const body = done.verboseDetail?.kind === 'lines' ? done.verboseDetail.lines.join('\n') : '';
    expect(body).toContain('== Catalog ==');
    expect(body).toContain('== Findings');
    expect(body).toContain('== Entry points');
    // The trailing "== Summary ==" block is suppressed (includeSummary: false).
    expect(body).not.toContain('== Summary ==');
    expect(exitCodes).toContain(0);
  });

  it('JSON mode emits the signal envelope', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await runExecuteGraph({ cwd: dir, json: true }, cli);
    const parsed = JSON.parse(stdout) as {
      tool: string;
      schemaVersion: number;
      signals: unknown[];
      verdict: { passed: boolean };
    };
    expect(parsed.tool).toBe('graph');
    expect(parsed.schemaVersion).toBe(2);
    expect(Array.isArray(parsed.signals)).toBe(true);
    expect(typeof parsed.verdict.passed).toBe('boolean');
    expect(exitCodes).toContain(0);
  });

  it('--gate-save writes a baseline to the SQLite store', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const { cli, exitCodes, render } = makeCli();
    await runExecuteGraph({ cwd: dir, gateSave: true }, cli);
    expect(renderedLines(render)).toContain(`Graph baseline saved`);
    expect(exitCodes).toContain(0);
  });

  it('--gate-compare returns PASS when current matches baseline (shared DataStore)', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const shared = makeCli();
    await runExecuteGraph({ cwd: dir, gateSave: true }, shared.cli);
    shared.render.mockClear();
    await runExecuteGraph({ cwd: dir, gateCompare: true }, shared.cli);
    expect(renderedLines(shared.render)).toContain('Graph gate PASS');
    expect(shared.exitCodes).toContain(0);
  });

  it('--gate-compare reports FAIL when there are new findings (shared DataStore)', async () => {
    setupFixture(dir, {
      'index.ts': `export function main(): void {}\n`,
    });
    const shared = makeCli();
    await runExecuteGraph({ cwd: dir, gateSave: true }, shared.cli);
    // Mutate fixture to add an orphan
    writeFileSync(
      join(dir, 'index.ts'),
      `function unused(): number { return 1; }\nexport function main(): void {}\n`,
      'utf8',
    );
    shared.render.mockClear();
    await runExecuteGraph({ cwd: dir, gateCompare: true, noCache: true }, shared.cli);
    expect(renderedLines(shared.render)).toContain('Graph gate FAILED');
    expect(shared.exitCodes).toContain(1);
  });

  it('errors when --gate-save and --gate-compare are passed together', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await runExecuteGraph({ cwd: dir, gateSave: true, gateCompare: true }, cli);
    expect(stderr).toContain('mutually exclusive');
    expect(exitCodes).toContain(2);
  });

  it('maps a missing tsconfig.json to a configuration-error exit code', async () => {
    // No tsconfig.json -> ConfigurationError surfaces
    mkdirSync(dir, { recursive: true });
    const { cli, exitCodes } = makeCli();
    await runExecuteGraph({ cwd: dir }, cli);
    expect(stderr).toContain('graph:');
    expect(exitCodes).toContain(2);
  });

  it('--report-to returns the envelope for the root to deliver (ADR-0011)', async () => {
    // Egress moved off executeGraph to the composition root (ADR-0011 Phase 5):
    // executeGraph renders the report and RETURNS the envelope; the root's
    // `cli.deliverSignals` owns cloud egress + the `--report-to` upload (and
    // exit code 4). That exit-4 behaviour is covered in the CLI's
    // envelope-routing tests — here we just assert the envelope is returned so
    // the root has something to deliver.
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const { cli, exitCodes } = makeCli();
    const envelope = await runExecuteGraph({ cwd: dir, reportTo: 'http://127.0.0.1:1' }, cli);
    expect(envelope?.tool).toBe('graph');
    expect(envelope?.schemaVersion).toBe(2);
    expect(exitCodes).toContain(0);
  });

  it('errors when --workspace and positional paths are passed together', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await runExecuteGraph({ cwd: dir, paths: ['foo'], workspace: true }, cli);
    expect(stderr).toContain('mutually exclusive');
    expect(exitCodes).toContain(2);
  });

  it('errors when --workspace is passed but cliScript is empty', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await runExecuteGraph({ cwd: dir, workspace: true, cliScript: '' }, cli);
    expect(stderr).toContain('CLI entry script');
    expect(exitCodes).toContain(2);
  });

  it('errors when --workspace is passed but no workspace units exist', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    // No packages/** dir exists — discoverWorkspaceUnits returns [].
    await runExecuteGraph({ cwd: dir, workspace: true, cliScript: '/usr/bin/node' }, cli);
    expect(stderr).toContain('no workspace units');
    expect(exitCodes).toContain(2);
  });

  it('positional <relative dir> scopes to a sub-package directory', async () => {
    // Create a nested package layout: cwd has its own tsconfig and the
    // sub-package has its own. Pass a positional path.
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    mkdirSync(join(dir, 'packages', 'inner'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'inner', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(
      join(dir, 'packages', 'inner', 'main.ts'),
      `export function fromInner(): number { return 1; }\n`,
      'utf8',
    );
    const { cli, exitCodes } = makeCli();
    await runExecuteGraph({ cwd: dir, paths: [join(dir, 'packages', 'inner')], json: true }, cli);
    const parsed = JSON.parse(stdout) as { tool: string };
    expect(parsed.tool).toBe('graph');
    expect(exitCodes).toContain(0);
  });

  it('--report-to with no findings renders the report and returns the envelope', async () => {
    // A clean run still returns an envelope (the root may still cloud-emit it);
    // executeGraph renders the normal graph report rather than a bespoke
    // "report sent" status line now that delivery lives at the root.
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes, render } = makeCli();
    const envelope = await runExecuteGraph({ cwd: dir, reportTo: 'http://127.0.0.1:1' }, cli);
    const done = render.mock.calls[0]?.[0] as GraphDoneLike;
    expect(done.type).toBe('graph-done');
    expect(envelope?.tool).toBe('graph');
    expect(envelope?.verdict.passed).toBe(true);
    expect(exitCodes).toContain(0);
  });

  it('--workspace runs successfully across discovered workspace units', async () => {
    // Set up a packages/** layout and run --packages. Use a CLI script
    // that prints a known JSON shape so the parent's parsing path is
    // exercised. We use `node -e ...` indirectly by pointing cliScript
    // at a tiny helper script written into the fixture.
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    // Two packages with tsconfigs.
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'b'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(
      join(dir, 'packages', 'a', 'main.ts'),
      `export function a(): number { return 1; }\n`,
      'utf8',
    );
    writeFileSync(join(dir, 'packages', 'b', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(
      join(dir, 'packages', 'b', 'main.ts'),
      `export function b(): number { return 1; }\n`,
      'utf8',
    );
    // Helper script that pretends to be the CLI for child invocations:
    // takes the graph subcommand args, ignores them, and emits an empty
    // SignalEnvelope JSON document (ADR-0011 — the parent parses .signals).
    const helper = join(dir, 'fake-cli.cjs');
    writeFileSync(
      helper,
      `process.stdout.write(JSON.stringify({\n` +
        `  schemaVersion: 2, tool: 'graph', recipe: 'graph',\n` +
        `  runId: 'r', createdAt: new Date().toISOString(),\n` +
        `  verdict: { score: 100, passed: true, summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 } },\n` +
        `  units: [], signals: []\n` +
        `}));\n` +
        `process.exit(0);\n`,
      'utf8',
    );
    const { cli, exitCodes } = makeCli();
    await runExecuteGraph(
      {
        cwd: dir,
        workspace: true,
        cliScript: helper,
        json: true,
        concurrency: 1,
      },
      cli,
    );
    const parsed = JSON.parse(stdout) as { tool: string; mode: string; units: unknown[] };
    expect(parsed.tool).toBe('graph');
    expect(parsed.mode).toBe('workspace');
    expect(parsed.units.length).toBeGreaterThanOrEqual(2);
    expect(exitCodes).toContain(0);
  });

  it('--workspace text report renders status + findings sections', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(
      join(dir, 'packages', 'a', 'main.ts'),
      `export function a(): number { return 1; }\n`,
      'utf8',
    );
    // Helper that emits one signal so the findings section renders (ADR-0011 —
    // the parent parses .signals off the child's SignalEnvelope stdout).
    const helper = join(dir, 'fake-cli.cjs');
    writeFileSync(
      helper,
      `process.stdout.write(JSON.stringify({\n` +
        `  schemaVersion: 2, tool: 'graph', recipe: 'graph',\n` +
        `  runId: 'r', createdAt: new Date().toISOString(),\n` +
        `  verdict: { score: 50, passed: false, summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 } },\n` +
        `  units: [{ slug: 'graph.dead-code.orphan-subtree', passed: true, durationMs: 0 }],\n` +
        `  signals: [{ id: 's1', source: 'graph.dead-code.orphan-subtree', provider: 'opensip-cli', severity: 'low', category: 'quality', ruleId: 'graph.dead-code.orphan-subtree', message: 'orphan x', filePath: 'main.ts', line: 1, column: 1, metadata: {}, createdAt: new Date().toISOString() }]\n` +
        `}));\n` +
        `process.exit(0);\n`,
      'utf8',
    );
    const { cli, exitCodes, render } = makeCli();
    await runExecuteGraph({ cwd: dir, workspace: true, cliScript: helper, concurrency: 1 }, cli);
    const out = renderedLines(render);
    expect(out).toContain('opensip graph --workspace');
    expect(out).toContain('== Units');
    expect(out).toContain('== Findings ==');
    expect(out).toContain('orphan x');
    expect(exitCodes).toContain(0);
  });

  // NOTE: the "gate mode without a DataStore" guard moved to the host seam
  // (getOrOpenDatastore / the BaselineRepo construction) in ADR-0036 — graph's
  // runGateMode no longer resolves the datastore itself. That missing-store
  // behavior is now covered host-side, so the former graph-typescript test for it
  // was removed here.

  it('--workspace surfaces child failure as a runtime-error exit code', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(
      join(dir, 'packages', 'a', 'main.ts'),
      `export function a(): number { return 1; }\n`,
      'utf8',
    );
    // Failing helper: writes some stderr + exits 1.
    const helper = join(dir, 'failing-cli.cjs');
    writeFileSync(helper, `process.stderr.write('boom\\n');\nprocess.exit(1);\n`, 'utf8');
    const { cli, exitCodes } = makeCli();
    await runExecuteGraph({ cwd: dir, workspace: true, cliScript: helper, concurrency: 1 }, cli);
    expect(exitCodes).toContain(1);
    expect(stderr).toContain('at least one unit run failed');
  });
});
