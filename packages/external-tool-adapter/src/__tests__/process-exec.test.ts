/**
 * runScannerProcess failure classification — the execFile callback branches.
 * External signal death (OOM killer, `kill -9`, container stop) arrives as
 * `{ killed: false, code: null, signal: 'SIG…' }` and must become a typed
 * KILLED_BY_SIGNAL rejection, never a fabricated ordinary `exit 1`.
 */

import { describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

import { runScannerProcess } from '../process-exec.js';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

const INPUT = {
  command: '/usr/bin/examplescan',
  args: ['scan'],
  cwd: '/proj',
  timeoutMs: 1000,
  maxBuffer: 1024,
};

function mockExecFailure(shape: Record<string, unknown>): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
      cb(Object.assign(new Error('scanner died'), shape), '', 'tail');
      return {} as never;
    },
  );
}

describe('runScannerProcess — external signal death', () => {
  it('rejects with KILLED_BY_SIGNAL instead of fabricating exit 1', async () => {
    mockExecFailure({ code: null, killed: false, signal: 'SIGKILL' });
    await expect(runScannerProcess(INPUT)).rejects.toMatchObject({
      code: 'EXTERNAL.SCANNER.KILLED_BY_SIGNAL',
      message: expect.stringContaining('SIGKILL'),
    });
  });

  it("keeps Node's own timeout kill classified as timedOut", async () => {
    mockExecFailure({ code: null, killed: true, signal: 'SIGTERM' });
    await expect(runScannerProcess(INPUT)).resolves.toMatchObject({
      timedOut: true,
      code: -1,
    });
  });

  it('keeps a real numeric exit code even when a signal field is present', async () => {
    // A scanner that traps a signal and exits with a code reports both; the
    // numeric code is the authoritative outcome.
    mockExecFailure({ code: 2, killed: false, signal: 'SIGTERM' });
    await expect(runScannerProcess(INPUT)).resolves.toMatchObject({
      code: 2,
      timedOut: false,
    });
  });

  it('still classifies string errno codes as spawn failures', async () => {
    mockExecFailure({ code: 'ENOENT', killed: false });
    await expect(runScannerProcess(INPUT)).rejects.toMatchObject({
      code: 'EXTERNAL.SCANNER.BINARY_MISSING',
    });
  });
});
