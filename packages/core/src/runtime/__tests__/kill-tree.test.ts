import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { killTree } from '../kill-tree.js';

const FIXTURE = fileURLToPath(new URL('fixtures/limit-worker.mjs', import.meta.url));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('killTree', () => {
  it('reaps a forked grandchild process group', async () => {
    const child = fork(FIXTURE, ['fork-grandchild'], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    await new Promise<void>((resolve) => {
      child.once('spawn', resolve);
    });
    await new Promise((r) => setTimeout(r, 300));
    const grandPid = child.pid;
    expect(grandPid).toBeDefined();
    killTree(child, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    if (grandPid !== undefined) expect(isAlive(grandPid)).toBe(false);
  });
});
