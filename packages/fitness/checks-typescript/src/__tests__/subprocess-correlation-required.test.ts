/**
 * @fileoverview Behaviour tests for the subprocess-correlation-required
 * architecture check (ADR-0054 readiness; subprocess-correlation-telemetry spec).
 */
import { runCheckOnFixture, type FixtureFile } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { analyzeSubprocessCorrelationRequired } from '../checks/architecture/subprocess-correlation-required.js';
import { checks } from '../index.js';

const SHARD_RUNNER = 'packages/graph/engine/src/cli/orchestrate/shard-runner.ts';
const WORKSPACE_RUNNER = 'packages/graph/engine/src/cli/workspace-runner.ts';
const HEAP_PREFLIGHT = 'packages/graph/engine/src/cli/heap-preflight.ts';
const OUT_OF_SCOPE = 'packages/core/src/runtime/subprocess-transport.ts';

function check() {
  const c = checks.find((x) => x.config.slug === 'subprocess-correlation-required');
  if (!c) throw new Error('check not found: subprocess-correlation-required');
  return c;
}

async function findingsFor(file: FixtureFile): Promise<number> {
  const run = await runCheckOnFixture(check(), { files: [file] });
  return run.findings.length;
}

describe('analyzeSubprocessCorrelationRequired (AST)', () => {
  it('flags a worker spawn that forwards env but not correlation', () => {
    const v = analyzeSubprocessCorrelationRequired(
      [
        "import { spawn } from 'node:child_process';",
        'export function spawnShardWorker(cliScript: string, specPath: string): void {',
        "  spawn(process.execPath, [cliScript, 'graph-shard-worker', specPath], {",
        '    env: { ...process.env },',
        '  });',
        '}',
      ].join('\n'),
      SHARD_RUNNER,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('RunCorrelation');
    expect(v[0]?.severity).toBe('error');
  });

  it('allows a worker spawn that merges correlationToEnv', () => {
    const v = analyzeSubprocessCorrelationRequired(
      [
        "import { spawn } from 'node:child_process';",
        "import { correlationToEnv, currentScope } from '@opensip-cli/core';",
        'export function spawnShardWorker(cliScript: string, specPath: string): void {',
        '  const correlation = currentScope()?.correlation;',
        "  spawn(process.execPath, [cliScript, 'graph-shard-worker', specPath], {",
        '    env: { ...process.env, ...(correlation ? correlationToEnv(correlation) : {}) },',
        '  });',
        '}',
      ].join('\n'),
      SHARD_RUNNER,
    );
    expect(v).toEqual([]);
  });

  it('allows a worker fork that writes a correlation field on the descriptor', () => {
    const v = analyzeSubprocessCorrelationRequired(
      [
        "import { fork } from 'node:child_process';",
        'export function forkWorker(command: string, specPath: string, correlation: unknown): void {',
        '  const descriptor = {',
        "    argv: ['graph-run-worker', specPath],",
        '    correlation,',
        '  };',
        '  void descriptor;',
        "  fork(command, ['graph-run-worker', specPath], { env: { ...process.env } });",
        '}',
      ].join('\n'),
      SHARD_RUNNER,
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag a plain (non-worker) subcommand spawn', () => {
    const v = analyzeSubprocessCorrelationRequired(
      [
        "import { spawn } from 'node:child_process';",
        'export function spawnGraphChild(cliScript: string, rootDir: string): void {',
        "  spawn(process.execPath, [cliScript, 'graph', rootDir, '--json'], {",
        '    env: process.env,',
        '  });',
        '}',
      ].join('\n'),
      WORKSPACE_RUNNER,
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag a same-process re-exec (no worker subcommand literal)', () => {
    const v = analyzeSubprocessCorrelationRequired(
      [
        "import { spawn } from 'node:child_process';",
        'export function elevate(): void {',
        '  spawn(process.execPath, process.argv.slice(1), {',
        '    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },',
        '    stdio: "inherit",',
        '  });',
        '}',
      ].join('\n'),
      HEAP_PREFLIGHT,
    );
    expect(v).toEqual([]);
  });
});

describe('subprocess-correlation-required (gate)', () => {
  it('flags an uncorrelated worker spawn under packages/graph', async () => {
    expect(
      await findingsFor({
        path: SHARD_RUNNER,
        content: [
          "import { spawn } from 'node:child_process';",
          'export function spawnShardWorker(cliScript: string, specPath: string): void {',
          "  spawn(process.execPath, [cliScript, 'graph-shard-worker', specPath], {",
          '    env: { ...process.env },',
          '  });',
          '}',
        ].join('\n'),
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag spawn/fork sites outside the gated packages', async () => {
    expect(
      await findingsFor({
        path: OUT_OF_SCOPE,
        content: [
          "import { fork } from 'node:child_process';",
          'export function forkWorker(command: string, specPath: string): void {',
          "  fork(command, ['graph-run-worker', specPath], { env: { ...process.env } });",
          '}',
        ].join('\n'),
      }),
    ).toBe(0);
  });
});
