/**
 * Tests for the executeGraph CLI handler.
 *
 * The handler is a façade that wires runGraph to one of three modes
 * (table, JSON, gate, report) plus error mapping. We exercise stdout
 * capture and the various flag combinations against fixture projects.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { configurePersistencePaths } from '@opensip-tools/contracts';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { executeGraph } from '../../cli/graph.js';

import type { ToolCliContext } from '@opensip-tools/core';

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
  configurePersistencePaths({
    sessionsDir: join(dir, '.sessions'),
    reportsDir: join(dir, '.reports'),
  });
}

interface CapturedCli {
  readonly cli: ToolCliContext;
  readonly exitCodes: number[];
}

function makeCli(): CapturedCli {
  const exitCodes: number[] = [];
  const cli: ToolCliContext = {
    program: {},
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    builtinLiveViews: new Map(),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    setExitCode: (c: number) => { exitCodes.push(c); },
    emitJson: vi.fn(),
  };
  return { cli, exitCodes };
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

  it('--gate-save writes a baseline file', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const baseline = join(dir, 'baseline.json');
    const { cli, exitCodes } = makeCli();
    await executeGraph({ cwd: dir, gateSave: true, baseline }, cli);
    expect(stdout).toContain(`Graph baseline saved to ${baseline}`);
    expect(exitCodes).toContain(0);
    const raw = readFileSync(baseline, 'utf8');
    const parsed = JSON.parse(raw) as { tool: string; version: string };
    expect(parsed.tool).toBe('graph');
    expect(parsed.version).toBe('1');
  });

  it('--gate-compare returns PASS when current matches baseline', async () => {
    setupFixture(dir, {
      'index.ts': `function unused(): number { return 1; }\nexport function main(): void {}\n`,
    });
    const baseline = join(dir, 'baseline.json');
    const cli1 = makeCli();
    await executeGraph({ cwd: dir, gateSave: true, baseline }, cli1.cli);
    stdout = '';
    const cli2 = makeCli();
    await executeGraph({ cwd: dir, gateCompare: true, baseline }, cli2.cli);
    expect(stdout).toContain('Graph gate PASS');
    expect(cli2.exitCodes).toContain(0);
  });

  it('--gate-compare reports FAIL when there are new findings', async () => {
    setupFixture(dir, {
      'index.ts': `export function main(): void {}\n`,
    });
    const baseline = join(dir, 'baseline.json');
    const cli1 = makeCli();
    await executeGraph({ cwd: dir, gateSave: true, baseline }, cli1.cli);
    // Mutate fixture to add an orphan
    writeFileSync(join(dir, 'index.ts'), `function unused(): number { return 1; }\nexport function main(): void {}\n`, 'utf8');
    stdout = '';
    const cli2 = makeCli();
    await executeGraph({ cwd: dir, gateCompare: true, baseline, noCache: true }, cli2.cli);
    expect(stdout).toContain('Graph gate FAILED');
    expect(cli2.exitCodes).toContain(1);
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
});
