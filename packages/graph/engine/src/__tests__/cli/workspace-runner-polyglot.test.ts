/**
 * Polyglot --workspace aggregation via mock adapters (D8b).
 *
 * Verifies that discoverPolyglotUnits walks every adapter that
 * implements `discoverWorkspaceUnits`, aggregates their units, and
 * returns them sorted by rootDir for deterministic fan-out order.
 * Adapters without the hook contribute zero units but don't throw.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RunScope,
  runWithScope,
  type LanguageAdapter,
  type WorkspaceUnit,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { discoverPolyglotUnits, runWorkspaceUnitsInParallel } from '../../cli/workspace-runner.js';

function mockAdapter(id: string, units?: readonly WorkspaceUnit[]): LanguageAdapter {
  return {
    id,
    fileExtensions: ['.x'],
    parse: () => null,
    stripStrings: (s) => s,
    stripComments: (s) => s,
    discoverWorkspaceUnits:
      units === undefined
        ? undefined
        : // eslint-disable-next-line @typescript-eslint/require-await
          async () => units,
  };
}

describe('discoverPolyglotUnits', () => {
  it('returns an empty list when no adapters are passed', async () => {
    const units = await discoverPolyglotUnits('/var/fixture-root', []);
    expect(units).toEqual([]);
  });

  it('aggregates units across multiple adapters', async () => {
    const tsUnits: WorkspaceUnit[] = [
      {
        id: 'ts-a',
        rootDir: '/root/ts/a',
        configPath: '/root/ts/a/tsconfig.json',
      },
      {
        id: 'ts-b',
        rootDir: '/root/ts/b',
        configPath: '/root/ts/b/tsconfig.json',
      },
      {
        id: 'ts-c',
        rootDir: '/root/ts/c',
        configPath: '/root/ts/c/tsconfig.json',
      },
    ];
    const rustUnits: WorkspaceUnit[] = [
      {
        id: 'crate-x',
        rootDir: '/root/crates/x',
        configPath: '/root/crates/x/Cargo.toml',
      },
      {
        id: 'crate-y',
        rootDir: '/root/crates/y',
        configPath: '/root/crates/y/Cargo.toml',
      },
    ];
    const ts = mockAdapter('typescript', tsUnits);
    const rust = mockAdapter('rust', rustUnits);
    const all = await discoverPolyglotUnits('/root', [ts, rust]);
    expect(all).toHaveLength(5);
    const ids = all.map((u) => u.id);
    expect(ids).toContain('ts-a');
    expect(ids).toContain('crate-x');
  });

  it('returns units sorted by rootDir', async () => {
    const ts = mockAdapter('typescript', [
      { id: 'ts-z', rootDir: '/root/z' },
      { id: 'ts-a', rootDir: '/root/a' },
    ]);
    const rust = mockAdapter('rust', [{ id: 'rust-m', rootDir: '/root/m' }]);
    const all = await discoverPolyglotUnits('/root', [ts, rust]);
    expect(all.map((u) => u.rootDir)).toEqual(['/root/a', '/root/m', '/root/z']);
  });

  it('skips adapters that omit discoverWorkspaceUnits without throwing', async () => {
    const ts = mockAdapter('typescript', [{ id: 'ts-a', rootDir: '/root/a' }]);
    const noHook = mockAdapter('mystery'); // no units arg → hook omitted
    const all = await discoverPolyglotUnits('/root', [ts, noHook]);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('ts-a');
  });

  it('returns determinstic order across runs', async () => {
    const ts = mockAdapter('typescript', [
      { id: 'a', rootDir: '/root/a' },
      { id: 'b', rootDir: '/root/b' },
    ]);
    const rust = mockAdapter('rust', [{ id: 'c', rootDir: '/root/c' }]);
    const a = await discoverPolyglotUnits('/root', [ts, rust]);
    const b = await discoverPolyglotUnits('/root', [rust, ts]);
    expect(a.map((u) => u.rootDir)).toEqual(b.map((u) => u.rootDir));
  });
});

describe('runWorkspaceUnitsInParallel', () => {
  it('forwards explicit language selection to graph child processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-runner-'));
    try {
      const unitRoot = join(root, 'packages', 'api');
      mkdirSync(unitRoot, { recursive: true });
      const argvPath = join(root, 'argv.jsonl');
      const cliScript = join(root, 'fake-cli.cjs');
      const configPath = join(root, 'custom opensip.yml');
      writeFileSync(
        cliScript,
        `
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const envelope = {
  tool: 'graph',
  runId: 'workspace-child',
  createdAt: '2026-01-01T00:00:00.000Z',
  verdict: {},
  units: [],
  signals: [],
};
process.stdout.write(JSON.stringify({ envelope }));
`,
        'utf8',
      );

      const out = await runWorkspaceUnitsInParallel({
        cwd: root,
        configPath,
        units: [{ id: 'api', rootDir: unitRoot }],
        cliScript,
        concurrency: 1,
        noCache: true,
        resolution: 'fast',
        language: 'python',
        recipe: 'public-api',
      });

      const argv = JSON.parse(readFileSync(argvPath, 'utf8').trim()) as string[];
      expect(out.anyChildFailed).toBe(false);
      expect(argv).toEqual([
        'graph',
        unitRoot,
        '--json',
        '--cwd',
        root,
        '--config',
        configPath,
        '--no-cache',
        '--resolution',
        'fast',
        '--language',
        'python',
        '--recipe',
        'public-api',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('faults the aggregate when a successful child emits malformed JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-runner-malformed-'));
    try {
      const unitRoot = join(root, 'packages', 'broken-output');
      mkdirSync(unitRoot, { recursive: true });
      const cliScript = join(root, 'malformed-cli.cjs');
      writeFileSync(cliScript, `process.stdout.write('{"signals":');\n`, 'utf8');

      const out = await runWorkspaceUnitsInParallel({
        cwd: root,
        units: [{ id: 'broken-output', rootDir: unitRoot }],
        cliScript,
        concurrency: 1,
        noCache: true,
      });

      expect(out.anyChildFailed).toBe(true);
      expect(out.perUnit[0]).toMatchObject({
        exitCode: 1,
        failureReason: 'output-malformed',
        errorCode: 'GRAPH.WORKSPACE.CHILD_OUTPUT_MALFORMED',
        failureClass: 'stdout_parse',
        failureCondition: 'invalid-json',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('terminates an active child and preserves host cancellation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-runner-cancel-'));
    const controller = new AbortController();
    const scope = new RunScope({ abortSignal: controller.signal });
    try {
      const unitRoot = join(root, 'packages', 'cancelled');
      mkdirSync(unitRoot, { recursive: true });
      const cliScript = join(root, 'cancel-cli.cjs');
      writeFileSync(cliScript, `setInterval(() => {}, 1000);\n`, 'utf8');

      const pending = runWithScope(scope, () =>
        runWorkspaceUnitsInParallel({
          cwd: root,
          units: [{ id: 'cancelled', rootDir: unitRoot }],
          cliScript,
          concurrency: 1,
          noCache: true,
        }),
      );
      queueMicrotask(() => controller.abort());

      await expect(pending).rejects.toMatchObject({ code: 'CORE.SYSTEM.CANCELLED' });
    } finally {
      scope.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('SIGKILLs a hung unit child after the hard kill-timeout instead of hanging forever', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-runner-hang-'));
    try {
      const unitRoot = join(root, 'packages', 'stuck');
      mkdirSync(unitRoot, { recursive: true });
      const cliScript = join(root, 'hang-cli.cjs');
      // A child that never exits and emits no output — keeps the event loop
      // alive, so it only ever settles via the hard kill-timeout.
      writeFileSync(cliScript, `setInterval(() => {}, 1000);\n`, 'utf8');

      const out = await runWorkspaceUnitsInParallel({
        cwd: root,
        units: [{ id: 'stuck', rootDir: unitRoot }],
        cliScript,
        concurrency: 1,
        noCache: true,
        hardKillTimeoutMs: 300, // tiny so the test is fast; the run must NOT hang
      });

      expect(out.anyChildFailed).toBe(true);
      expect(out.perUnit).toHaveLength(1);
      expect(out.perUnit[0]).toMatchObject({
        exitCode: 1,
        failureReason: 'timeout',
        errorCode: 'GRAPH.WORKSPACE.CHILD_TIMEOUT',
        failureClass: 'timeout',
        failureCondition: 'hard-kill-timeout',
      });
      expect(out.perUnit[0]?.stderr).toContain('hard deadline');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
