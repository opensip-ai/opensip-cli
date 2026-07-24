import { setMaxListeners } from 'node:events';
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

  it('settles from the caller-owned cancellation signal without a process listener', async () => {
    const controller = new AbortController();
    const baseline = process.listenerCount('SIGINT');
    let handle: ReturnType<typeof forkAndSettle> | undefined;
    const failure = new Promise<string>((resolve) => {
      handle = forkAndSettle({
        command: FIXTURE,
        argv: ['cancel-no-ack-ignore-term'],
        cancellationSignal: controller.signal,
        cancelAckGraceMs: 20,
        terminationGraceMs: 20,
        onMessage: (message) => {
          if ((message as { kind?: unknown }).kind === 'ready') controller.abort();
        },
        onLimitFailure: resolve,
      });
    });
    try {
      await expect(waitFor(failure, 1000, 'cancellation did not settle')).resolves.toBe(
        'cancelled',
      );
      expect(process.listenerCount('SIGINT')).toBe(baseline);
    } finally {
      handle?.dispose();
    }
  });

  it('fans one root AbortSignal out to concurrent children without process signal ownership', async () => {
    const baseline = process.listenerCount('SIGINT');
    const controller = new AbortController();
    setMaxListeners(0, controller.signal);
    const cancelled: string[] = [];
    const handles = Array.from({ length: 12 }, (_, index) =>
      forkAndSettle({
        command: FIXTURE,
        argv: ['timeout-sleep'],
        cancellationSignal: controller.signal,
        cancelAckGraceMs: 10,
        terminationGraceMs: 10,
        onLimitFailure: (fc) => {
          cancelled.push(`${String(index)}:${fc}`);
        },
      }),
    );
    try {
      expect(process.listenerCount('SIGINT')).toBe(baseline);
      controller.abort();
      await new Promise((r) => setTimeout(r, 150));
      // Every active child received the cancellation.
      expect(cancelled).toHaveLength(12);
      expect(cancelled.every((entry) => entry.endsWith(':cancelled'))).toBe(true);
      expect(process.listenerCount('SIGINT')).toBe(baseline);
    } finally {
      for (const handle of handles) handle.dispose();
    }
  });

  it.each(['cancel-ack-ignore-term', 'cancel-no-ack-ignore-term'])(
    'escalates %s from cooperative cancellation to SIGKILL',
    async (mode) => {
      const controller = new AbortController();
      let handle: ReturnType<typeof forkAndSettle> | undefined;
      let resolveReady = (): void => undefined;
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      const cancelled = new Promise<string>((resolve) => {
        handle = forkAndSettle({
          command: FIXTURE,
          argv: [mode],
          cancellationSignal: controller.signal,
          cancelAckGraceMs: 30,
          terminationGraceMs: 30,
          onMessage: (message) => {
            if ((message as { kind?: unknown }).kind === 'ready') resolveReady();
          },
          onLimitFailure: resolve,
        });
      });
      if (handle === undefined) throw new Error('worker handle was not created');
      const childExit = new Promise<NodeJS.Signals | null>((resolve) => {
        handle?.child.once('exit', (_code, signal) => resolve(signal));
      });
      try {
        await waitFor(ready, 1000, 'worker did not become ready');
        controller.abort();
        await expect(waitFor(cancelled, 1000, 'cancellation did not settle')).resolves.toBe(
          'cancelled',
        );
        await expect(waitFor(childExit, 1000, 'worker was not hard-killed')).resolves.toBe(
          'SIGKILL',
        );
      } finally {
        handle.dispose();
      }
    },
  );

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
