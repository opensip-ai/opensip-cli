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

import { RunScope } from '@opensip-tools/core';
import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { executeGraph, registerAdapter } from '@opensip-tools/graph';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

import type { ToolCliContext } from '@opensip-tools/core';

registerAdapter(typescriptGraphAdapter);

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

interface CapturedCli {
  readonly cli: ToolCliContext;
  readonly exitCodes: number[];
  readonly datastore: DataStore;
}

function makeCli(): CapturedCli {
  const exitCodes: number[] = [];
  const datastore = DataStoreFactory.open({ backend: 'memory' });
  const project = {
    cwd: '/test',
    cwdExplicit: false,
    projectRoot: '/test',
    configPath: undefined,
    walkedUp: 0,
    scope: 'none' as const,
  };
  const cli: ToolCliContext = {
    program: {},
    scope: new RunScope({ projectContext: project, datastore: () => datastore }),
    project,
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    setExitCode: (c: number) => { exitCodes.push(c); },
    emitJson: vi.fn(),
    datastore,
  };
  return { cli, exitCodes, datastore };
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

  it('default mode prints the unified text report', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir }, cli);
    expect(stdout).toContain('opensip-tools graph');
    expect(stdout).toContain('== Catalog ==');
    expect(stdout).toContain('== Findings');
    expect(stdout).toContain('== Entry points');
    expect(stdout).toContain('== Summary ==');
    expect(exitCodes).toContain(0);
  });

  it('JSON mode prints a CliOutput-shaped document', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir, json: true }, cli);
    const parsed = JSON.parse(stdout) as { tool: string; recipe: string; checks: unknown[] };
    expect(parsed.tool).toBe('graph');
    expect(parsed.recipe).toBe('graph');
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(exitCodes).toContain(0);
  });

  it('--gate-save writes a baseline to the SQLite store', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir, gateSave: true }, cli);
    expect(stdout).toContain(`Graph baseline saved`);
    expect(exitCodes).toContain(0);
  });

  it('--gate-compare returns PASS when current matches baseline (shared DataStore)', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const shared = makeCli();
    await executeGraph({ cwd: dir, gateSave: true }, shared.cli);
    stdout = '';
    await executeGraph({ cwd: dir, gateCompare: true }, shared.cli);
    expect(stdout).toContain('Graph gate PASS');
    expect(shared.exitCodes).toContain(0);
  });

  it('--gate-compare reports FAIL when there are new findings (shared DataStore)', async () => {
    setupFixture(dir, {
      'index.ts': `export function main(): void {}\n`,
    });
    const shared = makeCli();
    await executeGraph({ cwd: dir, gateSave: true }, shared.cli);
    // Mutate fixture to add an orphan
    writeFileSync(join(dir, 'index.ts'), `function unused(): number { return 1; }\nexport function main(): void {}\n`, 'utf8');
    stdout = '';
    await executeGraph({ cwd: dir, gateCompare: true, noCache: true }, shared.cli);
    expect(stdout).toContain('Graph gate FAILED');
    expect(shared.exitCodes).toContain(1);
  });

  it('errors when --gate-save and --gate-compare are passed together', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir, gateSave: true, gateCompare: true }, cli);
    expect(stderr).toContain('mutually exclusive');
    expect(exitCodes).toContain(2);
  });

  it('maps a missing tsconfig.json to a configuration-error exit code', async () => {
    // No tsconfig.json -> ConfigurationError surfaces
    mkdirSync(dir, { recursive: true });
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir }, cli);
    expect(stderr).toContain('graph:');
    expect(exitCodes).toContain(2);
  });

  it('--report-to with an unreachable URL returns a report-failed exit code', async () => {
    // Need at least one finding so reportToCloud actually fires the
    // request — otherwise it short-circuits to success.
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const { cli, exitCodes } = makeCli();
    // Use an obviously dead, reserved port to force fetch failure quickly.
    await executeGraph({ cwd: dir, reportTo: 'http://127.0.0.1:1' }, cli);
    expect(exitCodes).toContain(4);
    expect(stderr).toContain('Graph report failed');
  });

  it('errors when --package and --packages are passed together', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir, packageScope: 'foo', allPackages: true }, cli);
    expect(stderr).toContain('mutually exclusive');
    expect(exitCodes).toContain(2);
  });

  it('errors when --packages is passed but cliScript is empty', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir, allPackages: true, cliScript: '' }, cli);
    expect(stderr).toContain('CLI entry script');
    expect(exitCodes).toContain(2);
  });

  it('errors when --packages is passed but no workspace packages exist', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    // No packages/** dir exists — discoverWorkspacePackages returns [].
    await executeGraph(
      { cwd: dir, allPackages: true, cliScript: '/usr/bin/node' },
      cli,
    );
    expect(stderr).toContain('no workspace packages');
    expect(exitCodes).toContain(2);
  });

  it('--package <relative dir> scopes to a sub-package tsconfig', async () => {
    // Create a nested package layout: cwd has its own tsconfig and the
    // sub-package has its own. Pass `--package` as an explicit path.
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    mkdirSync(join(dir, 'packages', 'inner'), { recursive: true });
    writeFileSync(
      join(dir, 'packages', 'inner', 'tsconfig.json'),
      FIXTURE_TSCONFIG,
      'utf8',
    );
    writeFileSync(
      join(dir, 'packages', 'inner', 'main.ts'),
      `export function fromInner(): number { return 1; }\n`,
      'utf8',
    );
    const { cli, exitCodes } = makeCli();
    await executeGraph(
      { cwd: dir, packageScope: 'packages/inner', json: true },
      cli,
    );
    const parsed = JSON.parse(stdout) as { tool: string };
    expect(parsed.tool).toBe('graph');
    expect(exitCodes).toContain(0);
  });

  it('--report-to with no findings short-circuits to success', async () => {
    // No findings — reportToCloud short-circuits and returns success.
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir, reportTo: 'http://127.0.0.1:1' }, cli);
    // Should succeed because the "no findings" short-circuit doesn't
    // attempt the network request.
    expect(stdout).toContain('Graph report sent');
    expect(exitCodes).toContain(0);
  });

  it('--packages runs successfully across discovered package dirs', async () => {
    // Set up a packages/** layout and run --packages. Use a CLI script
    // that prints a known JSON shape so the parent's parsing path is
    // exercised. We use `node -e ...` indirectly by pointing cliScript
    // at a tiny helper script written into the fixture.
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    // Two packages with tsconfigs.
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    mkdirSync(join(dir, 'packages', 'b'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'packages', 'a', 'main.ts'), `export function a(): number { return 1; }\n`, 'utf8');
    writeFileSync(join(dir, 'packages', 'b', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'packages', 'b', 'main.ts'), `export function b(): number { return 1; }\n`, 'utf8');
    // Helper script that pretends to be the CLI for child invocations:
    // takes the graph subcommand args, ignores them, and emits an empty
    // CliOutput JSON document.
    const helper = join(dir, 'fake-cli.cjs');
    writeFileSync(
      helper,
      `process.stdout.write(JSON.stringify({\n` +
        `  version: '1.0', tool: 'graph', recipe: 'graph',\n` +
        `  timestamp: new Date().toISOString(), durationMs: 0,\n` +
        `  score: 100, passed: true, summary: 'ok', checks: []\n` +
        `}));\n` +
        `process.exit(0);\n`,
      'utf8',
    );
    const { cli, exitCodes } = makeCli();
    await executeGraph(
      {
        cwd: dir,
        allPackages: true,
        cliScript: helper,
        json: true,
        packagesConcurrency: 1,
      },
      cli,
    );
    const parsed = JSON.parse(stdout) as { tool: string; mode: string; packages: unknown[] };
    expect(parsed.tool).toBe('graph');
    expect(parsed.mode).toBe('packages');
    expect(parsed.packages.length).toBeGreaterThanOrEqual(2);
    expect(exitCodes).toContain(0);
  });

  it('--packages text report renders status + findings sections', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'packages', 'a', 'main.ts'), `export function a(): number { return 1; }\n`, 'utf8');
    // Helper that emits one finding so the findings section renders.
    const helper = join(dir, 'fake-cli.cjs');
    writeFileSync(
      helper,
      `process.stdout.write(JSON.stringify({\n` +
        `  version: '1.0', tool: 'graph', recipe: 'graph',\n` +
        `  timestamp: new Date().toISOString(), durationMs: 0,\n` +
        `  score: 50, passed: false, summary: 'one',\n` +
        `  checks: [{\n` +
        `    checkSlug: 'graph:orphan-subtree', passed: false, violationCount: 1,\n` +
        `    findings: [{ ruleId: 'graph:orphan-subtree', message: 'orphan x', severity: 'low', filePath: 'main.ts', line: 1, column: 1 }],\n` +
        `    durationMs: 0\n` +
        `  }]\n` +
        `}));\n` +
        `process.exit(0);\n`,
      'utf8',
    );
    const { cli, exitCodes } = makeCli();
    await executeGraph(
      { cwd: dir, allPackages: true, cliScript: helper, packagesConcurrency: 1 },
      cli,
    );
    expect(stdout).toContain('opensip-tools graph --packages');
    expect(stdout).toContain('== Packages');
    expect(stdout).toContain('== Findings ==');
    expect(stdout).toContain('orphan x');
    expect(exitCodes).toContain(0);
  });

  it('gate mode without a DataStore raises a configuration error', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    // Build a CLI without a datastore
    const exitCodes: number[] = [];
    const projectNoStore = {
      cwd: '/test',
      cwdExplicit: false,
      projectRoot: '/test',
      configPath: undefined,
      walkedUp: 0,
      scope: 'none' as const,
    };
    const cli: ToolCliContext = {
      program: {},
      scope: new RunScope({ projectContext: projectNoStore }),
      project: projectNoStore,
      render: vi.fn(() => Promise.resolve()),
      renderLive: vi.fn(() => Promise.resolve()),
      maybeOpenDashboard: vi.fn(() => Promise.resolve()),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      setExitCode: (c: number) => { exitCodes.push(c); },
      emitJson: vi.fn(),
      registerLiveView: vi.fn(),
      datastore: undefined,
    };
    await executeGraph({ cwd: dir, gateSave: true }, cli);
    expect(stderr).toContain('requires a DataStore');
    expect(exitCodes).toContain(2);
  });

  it('--packages surfaces child failure as a runtime-error exit code', async () => {
    setupFixture(dir, { 'index.ts': `export function x(): number { return 1; }\n` });
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'tsconfig.json'), FIXTURE_TSCONFIG, 'utf8');
    writeFileSync(join(dir, 'packages', 'a', 'main.ts'), `export function a(): number { return 1; }\n`, 'utf8');
    // Failing helper: writes some stderr + exits 1.
    const helper = join(dir, 'failing-cli.cjs');
    writeFileSync(
      helper,
      `process.stderr.write('boom\\n');\nprocess.exit(1);\n`,
      'utf8',
    );
    const { cli, exitCodes } = makeCli();
    await executeGraph(
      { cwd: dir, allPackages: true, cliScript: helper, packagesConcurrency: 1 },
      cli,
    );
    expect(exitCodes).toContain(1);
    expect(stderr).toContain('at least one package run failed');
  });
});
