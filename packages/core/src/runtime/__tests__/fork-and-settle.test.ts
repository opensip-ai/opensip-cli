import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { forkAndSettle } from '../fork-and-settle.js';

const FIXTURE = fileURLToPath(new URL('fixtures/limit-worker.mjs', import.meta.url));

describe('forkAndSettle', () => {
  afterEach(() => {
    delete process.env.OPENSIP_CLI_WORKER_TIMEOUT_MS;
    delete process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES;
    delete process.env.OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS;
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
});
