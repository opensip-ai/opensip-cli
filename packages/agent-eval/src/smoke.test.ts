import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CLI_DEPENDENCIES, main, markdownPathFor } from './cli.js';
import { validateEvalReport } from './report/model.js';
import { workspaceCliDistPath } from './runner/spawn.js';
import { taskRegistry } from './tasks/index.js';

import type { Arm, GoldTask } from './model/task.js';
import type { EvaluatedArmRun } from './runner/run-task.js';
import type { CliTarget } from './runner/spawn.js';

const SMOKE_TASK_ID = 'entrypoint-trace.customer-ts';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'agent-eval-smoke-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function smokeTask(): GoldTask {
  const task = taskRegistry[SMOKE_TASK_ID];
  if (task === undefined) throw new Error(`Missing smoke task ${SMOKE_TASK_ID}`);
  return task;
}

function armResult(task: GoldTask, arm: Arm): EvaluatedArmRun {
  return {
    assertions: { incorrectNone: 0, passed: true, scopes: [] },
    metrics: {
      callCount: 1,
      incorrectNone: 0,
      responseBytes: 10,
      timeToFirstUsefulContextMs: 1,
      totalWallMs: 1,
    },
    record: {
      arm,
      legs: [],
      setup: { mode: 'fixture', stages: [] },
      strategyVersion: task.strategies[arm].version,
      taskId: task.id,
    },
    recoveryMetrics: { callCount: 0, responseBytes: 0, totalWallMs: 0 },
  };
}

describe('--smoke', () => {
  it('selects exactly the customer-ts entrypoint task, runs both arms, and uses report validation', async () => {
    const root = temporaryDirectory();
    const jsonPath = join(root, 'smoke.json');
    const calls: string[] = [];
    let stdout = '';
    let stderr = '';
    const exitCode = await main(['--smoke', '--json', jsonPath], {
      ...DEFAULT_CLI_DEPENDENCIES,
      cwd: () => root,
      harnessVersion: '0.6.0',
      nodeVersion: 'v24.0.0',
      now: () => new Date('2026-07-12T20:00:00.000Z'),
      platform: 'test-platform',
      resolveCliVersion: () => Promise.resolve('0.6.0'),
      resolveGitProvenance: () => Promise.resolve({ gitSha: 'abcdef123456', worktreeDirty: false }),
      resultsRoot: join(root, 'results'),
      runArm: (task, arm) => {
        calls.push(`${task.id}:${arm}`);
        return Promise.resolve(armResult(task, arm));
      },
      stderr: (text) => {
        stderr += text;
      },
      stdout: (text) => {
        stdout += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([`${SMOKE_TASK_ID}:control`, `${SMOKE_TASK_ID}:opensip`]);
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(validateEvalReport(parsed)).toBe(true);
    expect(parsed).toMatchObject({
      promotionEligible: true,
      selectedArms: ['control', 'opensip'],
      sourceState: 'clean',
      tasks: [{ taskId: SMOKE_TASK_ID }],
    });
    expect(existsSync(markdownPathFor(jsonPath))).toBe(true);
    expect(stdout).toContain(`Report: ${jsonPath}`);
    expect(stderr).toContain(`${SMOKE_TASK_ID} [control] starting`);
    expect(stderr).toContain(`${SMOKE_TASK_ID} [opensip] complete`);
  });

  it('fails as an invocation when a caller tries to narrow the smoke arm', async () => {
    let stderr = '';
    const exitCode = await main(['--smoke', '--arm', 'control'], {
      ...DEFAULT_CLI_DEPENDENCIES,
      stderr: (text) => {
        stderr += text;
      },
      stdout: () => undefined,
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain('Usage: pnpm agent-eval');
  });

  it('threads a fake installed JS bin target through smoke — never the workspace dist', async () => {
    const root = temporaryDirectory();
    const entrypoint = join(root, 'installed-cli.js');
    writeFileSync(entrypoint, 'export default 1;\n', 'utf8');
    const jsonPath = join(root, 'installed-smoke.json');
    const targets: CliTarget[] = [];

    const exitCode = await main(
      ['--smoke', '--opensip-entrypoint', entrypoint, '--json', jsonPath],
      {
        ...DEFAULT_CLI_DEPENDENCIES,
        cwd: () => root,
        harnessVersion: '0.6.0',
        nodeVersion: 'v24.0.0',
        now: () => new Date('2026-07-12T20:00:00.000Z'),
        platform: 'test-platform',
        resolveCliVersion: (target) => {
          targets.push(target);
          return Promise.resolve('0.6.0');
        },
        resolveGitProvenance: () =>
          Promise.resolve({ gitSha: 'abcdef123456', worktreeDirty: false }),
        resultsRoot: join(root, 'results'),
        runArm: (task, arm, target) => {
          targets.push(target);
          return Promise.resolve(armResult(task, arm));
        },
        stderr: () => undefined,
        stdout: () => undefined,
      },
    );

    expect(exitCode).toBe(0);
    // Every version + arm run measured the SAME immutable installed target.
    expect(targets.length).toBeGreaterThanOrEqual(3);
    for (const target of targets) {
      expect(target.source).toBe('installed');
      expect(target.entrypoint).toBe(realpathSync(entrypoint));
      expect(target.entrypoint).not.toBe(workspaceCliDistPath());
    }
    const report: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(report).toMatchObject({
      cliTarget: { entrypointName: 'installed-cli.js', source: 'installed' },
    });
  });

  it('pins the designated smoke task in the live registry', () => {
    expect(smokeTask().id).toBe(SMOKE_TASK_ID);
  });
});
