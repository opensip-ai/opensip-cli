import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { forkAndSettle } from '../fork-and-settle.js';

const FIXTURE = fileURLToPath(new URL('fixtures/limit-worker.mjs', import.meta.url));

async function waitFor<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe('forkAndSettle', () => {
  afterEach(() => {
    delete process.env.OPENSIP_CLI_WORKER_TIMEOUT_MS;
    delete process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES;
    delete process.env.OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS;
    delete process.env.OPENSIP_CLI_WORKER_IDLE_RPC_MS;
    delete process.env.OPENSIP_CLI_WORKER_STDERR_INHERIT;
  });

  it('settles exactly once and kills on settle', async () => {
    let settled = false;
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['heartbeat-ok'],
      enableHeartbeat: true,
      limits: { heartbeatGraceMs: 5000 },
      onMessage: (msg) => {
        if ((msg as { kind?: string }).kind === 'result') {
          handle.done(() => {
            settled = true;
          });
        }
      },
    });
    await new Promise((r) => setTimeout(r, 2500));
    expect(settled).toBe(true);
    expect(handle.isSettled()).toBe(true);
    expect(handle.sendToChild({ kind: 'after-settle' })).toBe(false);
  });

  it('passes descriptor env and run id to the child when requested', async () => {
    const received = await new Promise<{ custom?: string; runId?: string }>((resolve) => {
      const handle = forkAndSettle(
        {
          command: FIXTURE,
          argv: ['env-report'],
          env: { OPENSIP_TEST_CUSTOM: 'from-descriptor' },
          onMessage: (msg) => {
            handle.done(() => {
              resolve(msg as { custom?: string; runId?: string });
            });
          },
        },
        { runId: 'run-123' },
      );
    });

    expect(received).toMatchObject({
      custom: 'from-descriptor',
      runId: 'run-123',
    });
  });

  it('allows callers to build the full child env explicitly', async () => {
    const received = await new Promise<{ custom?: string; runId?: string }>((resolve) => {
      const handle = forkAndSettle(
        {
          command: FIXTURE,
          argv: ['env-report'],
          buildChildEnv: (parentEnv, ctx) => ({
            ...parentEnv,
            OPENSIP_TEST_CUSTOM: `builder:${ctx.runId ?? 'none'}`,
          }),
          onMessage: (msg) => {
            handle.done(() => {
              resolve(msg as { custom?: string; runId?: string });
            });
          },
        },
        { runId: 'run-builder' },
      );
    });

    expect(received).toMatchObject({
      custom: 'builder:run-builder',
    });
    expect(received.runId).toBeUndefined();
  });

  it('can inherit stderr instead of capturing a tail', async () => {
    process.env.OPENSIP_CLI_WORKER_STDERR_INHERIT = '1';
    let tail: string | undefined = 'not-read';
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['env-report'],
      onMessage: () => {
        tail = handle.getStderrTail();
        handle.done(() => undefined);
      },
    });

    await new Promise((r) => setTimeout(r, 500));
    expect(tail).toBeUndefined();
    handle.dispose();
  });

  it('rejects oversized IPC payloads on receive', async () => {
    process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES = '1024';
    let failureClass: string | undefined;
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['huge-payload'],
      onLimitFailure: (fc) => {
        failureClass = fc;
      },
    });
    await new Promise((r) => setTimeout(r, 2000));
    expect(failureClass).toBe('payload_too_large');
    handle.dispose();
  });

  it('kills on heartbeat miss', async () => {
    process.env.OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS = '500';
    let failureClass: string | undefined;
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['heartbeat-sleep'],
      enableHeartbeat: true,
      onLimitFailure: (fc) => {
        failureClass = fc;
      },
    });
    await new Promise((r) => setTimeout(r, 2500));
    expect(failureClass).toBe('heartbeat_missed');
    handle.dispose();
  });

  it('kills on wall-clock timeout', async () => {
    process.env.OPENSIP_CLI_WORKER_TIMEOUT_MS = '500';
    let failureClass: string | undefined;
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['timeout-sleep'],
      onLimitFailure: (fc) => {
        failureClass = fc;
      },
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(failureClass).toBe('timeout');
    handle.dispose();
  });

  it('resets the idle RPC timer on inbound worker messages and fails when it expires', async () => {
    let handle: ReturnType<typeof forkAndSettle> | undefined;
    const failure = new Promise<{ failureClass: string; detail?: string }>((resolve) => {
      handle = forkAndSettle({
        command: FIXTURE,
        argv: ['message-then-idle'],
        limits: { idleRpcMs: 50 },
        onMessage: () => undefined,
        onLimitFailure: (failureClass, detail) => {
          resolve({ failureClass, detail });
        },
      });
    });

    try {
      const result = await waitFor(failure, 2000, 'timed out waiting for idle RPC limit failure');
      expect(result.failureClass).toBe('timeout');
      expect(result.detail).toContain('host-RPC idle timer exceeded 50ms');
    } finally {
      if (handle !== undefined) {
        handle.dispose();
      }
    }
  });

  it('kills when RSS exceeds the configured ceiling', async () => {
    let failureClass: string | undefined;
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['rss-hold'],
      limits: { maxRssMb: 1 },
      onLimitFailure: (fc) => {
        failureClass = fc;
      },
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(failureClass).toBe('rss_exceeded');
    handle.dispose();
  });

  it('settles as cancelled on SIGINT', async () => {
    let failureClass: string | undefined;
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['timeout-sleep'],
      enableSigintCancellation: true,
      onLimitFailure: (fc) => {
        failureClass = fc;
      },
    });
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 100));
    expect(failureClass).toBe('cancelled');
    handle.dispose();
  });

  it('converts child process errors into spawn failures once', async () => {
    let failureClass: string | undefined;
    let detail: string | undefined;
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['timeout-sleep'],
      onLimitFailure: (fc, d) => {
        failureClass = fc;
        detail = d;
      },
    });

    handle.child.emit('error', new Error('fork failed'));
    handle.child.emit('error', new Error('second error ignored'));
    await new Promise((r) => setTimeout(r, 50));
    expect(failureClass).toBe('spawn');
    expect(detail).toBe('fork failed');
    handle.dispose();
  });

  it('sends host messages to the child when connected', async () => {
    const echoed = await new Promise<unknown>((resolve) => {
      const handle = forkAndSettle({
        command: FIXTURE,
        argv: ['echo'],
        onMessage: (msg) => {
          if ((msg as { kind?: string }).kind === 'ready') {
            expect(handle.sendToChild({ kind: 'ping', value: 42 })).toBe(true);
            return;
          }
          if ((msg as { kind?: string }).kind === 'echo') {
            handle.done(() => {
              resolve((msg as { msg?: unknown }).msg);
            });
          }
        },
      });
    });

    expect(echoed).toEqual({ kind: 'ping', value: 42 });
  });

  it('rejects oversized outbound IPC payloads before sending to the child', async () => {
    let failureClass: string | undefined;
    const accepted = await new Promise<boolean>((resolve) => {
      const handle = forkAndSettle({
        command: FIXTURE,
        argv: ['echo'],
        limits: { maxIpcBytes: 64 },
        onLimitFailure: (fc) => {
          failureClass = fc;
        },
        onMessage: (msg) => {
          if ((msg as { kind?: string }).kind === 'ready') {
            resolve(handle.sendToChild({ value: 'x'.repeat(256) }));
          }
        },
      });
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(accepted).toBe(false);
    expect(failureClass).toBe('payload_too_large');
  });

  it('captures truncated stderr tail on failure', async () => {
    let tail: string | undefined;
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['stderr-flood'],
      onMessage: (msg) => {
        if ((msg as { kind?: string }).kind === 'error') {
          tail = handle.getStderrTail();
          handle.done(() => undefined);
        }
      },
    });
    await new Promise((r) => setTimeout(r, 2000));
    expect(tail).toContain('line-');
    handle.dispose();
  });

  it('disposes an unsettled worker and marks it settled', () => {
    const handle = forkAndSettle({
      command: FIXTURE,
      argv: ['timeout-sleep'],
    });

    handle.noteHeartbeat();
    handle.dispose();
    expect(handle.isSettled()).toBe(true);
  });
});
