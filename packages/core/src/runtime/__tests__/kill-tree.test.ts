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

async function waitUntilDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('killTree', () => {
  it('reaps a forked grandchild process group', async () => {
    const child = fork(FIXTURE, ['fork-grandchild'], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const grandPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('grandchild pid not reported')), 2000);
      child.on('message', (msg: unknown) => {
        if (
          typeof msg === 'object' &&
          msg !== null &&
          (msg as { kind?: unknown }).kind === 'grandchild'
        ) {
          clearTimeout(timer);
          resolve((msg as { pid: number }).pid);
        }
      });
    });
    expect(grandPid).toBeGreaterThan(0);
    const childExited = new Promise((resolve) => child.once('exit', resolve));
    killTree(child, 'SIGKILL');
    await Promise.all([childExited, waitUntilDead(grandPid)]);
    expect(isAlive(grandPid)).toBe(false);
  });
});
