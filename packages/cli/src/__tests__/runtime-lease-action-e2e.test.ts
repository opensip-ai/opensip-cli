/**
 * Requires a built CLI. Proves a real long-lived command retains its runtime
 * reader through action execution and releases it only after SQLite teardown.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireRuntimeExclusiveLease, inspectRuntimeLeaseState } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_DIST = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const POLICY = {
  waitMs: 250,
  staleMs: 5000,
  heartbeatMs: 100,
  pollMs: 5,
};

let priorHome: string | undefined;
let home = '';
let project = '';
let child: ChildProcess | undefined;

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for runtime lease state');
}

function waitForClose(process: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for CLI child exit')),
      timeoutMs,
    );
    process.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    process.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

afterEach(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await waitForClose(child, 5000).catch(() => undefined);
  }
  child = undefined;
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('runtime lease action lifetime', () => {
  it('blocks maintenance while MCP is live and releases after its datastore closes', async () => {
    priorHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'opensip-runtime-action-home-'));
    project = mkdtempSync(join(tmpdir(), 'opensip-runtime-action-project-'));
    process.env.HOME = home;
    writeFileSync(
      join(project, 'opensip-cli.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );

    let stderr = '';
    child = spawn(process.execPath, [CLI_DIST, '--no-cloud', 'mcp', '--cwd', project], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        XDG_CACHE_HOME: join(home, 'xdg-cache'),
        XDG_CONFIG_HOME: join(home, 'xdg-config'),
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return (
        state.status === 'stable' &&
        state.projectReaders === 1 &&
        state.userStateReaders === 1 &&
        existsSync(join(project, 'opensip-cli', '.runtime', 'datastore.sqlite'))
      );
    });

    await expect(
      acquireRuntimeExclusiveLease({
        projectDir: project,
        command: 'runtime-action-e2e-maintainer',
        cwdBasename: 'runtime-action-e2e',
        policy: POLICY,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT.RUNTIME_LEASE.EXCLUSIVE' });

    const closed = waitForClose(child);
    child.stdin?.end();
    await expect(closed).resolves.toBe(0);
    expect(stderr).not.toMatch(/error|failed/i);

    await waitUntil(async () => {
      const state = await inspectRuntimeLeaseState(project);
      return (
        state.status === 'stable' && state.projectReaders === 0 && state.userStateReaders === 0
      );
    });
    const maintainer = await acquireRuntimeExclusiveLease({
      projectDir: project,
      command: 'runtime-action-e2e-maintainer',
      cwdBasename: 'runtime-action-e2e',
      policy: { ...POLICY, waitMs: 2000 },
    });
    maintainer.release();
  }, 60_000);
});
