import { afterEach, describe, expect, it } from 'vitest';

import { getWorkerLimits, workerLimitsEnv } from '../worker-limits.js';

describe('worker-limits', () => {
  afterEach(() => {
    delete process.env.OPENSIP_CLI_WORKER_TIMEOUT_MS;
    delete process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES;
    delete process.env.OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS;
  });

  it('returns balanced defaults', () => {
    const limits = getWorkerLimits();
    expect(limits.timeoutMs).toBe(120_000);
    expect(limits.maxIpcBytes).toBe(32 * 1024 * 1024);
    expect(limits.maxOldSpaceMb).toBe(4096);
    expect(limits.maxRssMb).toBe(6144);
    expect(limits.maxConcurrentRpc).toBe(1);
    expect(limits.maxTotalRpc).toBe(5000);
    expect(limits.heartbeatGraceMs).toBe(60_000);
  });

  it('reads overrides from env via registry', () => {
    process.env.OPENSIP_CLI_WORKER_TIMEOUT_MS = '5000';
    process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES = '4096';
    process.env.OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS = '800';
    expect(getWorkerLimits().timeoutMs).toBe(5000);
    expect(getWorkerLimits().maxIpcBytes).toBe(4096);
    expect(getWorkerLimits().heartbeatGraceMs).toBe(800);
    expect(workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_TIMEOUT_MS')).toBe(5000);
  });
});
