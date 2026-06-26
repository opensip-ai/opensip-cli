import { afterEach, describe, expect, it } from 'vitest';

import { getWorkerLimits, workerExecArgv, workerLimitsEnv } from '../worker-limits.js';

const WORKER_ENV_KEYS = [
  'OPENSIP_CLI_WORKER_TIMEOUT_MS',
  'OPENSIP_CLI_WORKER_MAX_IPC_BYTES',
  'OPENSIP_CLI_WORKER_MAX_OLD_SPACE_MB',
  'OPENSIP_CLI_WORKER_MAX_RSS_MB',
  'OPENSIP_CLI_WORKER_MAX_CONCURRENT_RPC',
  'OPENSIP_CLI_WORKER_MAX_TOTAL_RPC',
  'OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS',
  'OPENSIP_CLI_WORKER_IDLE_RPC_MS',
  'OPENSIP_CLI_WORKER_MAX_CAPTURED_OUTPUT_BYTES',
  'OPENSIP_CLI_WORKER_STDERR_INHERIT',
] as const;

describe('worker-limits', () => {
  afterEach(() => {
    for (const key of WORKER_ENV_KEYS) delete process.env[key];
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
    process.env.OPENSIP_CLI_WORKER_MAX_OLD_SPACE_MB = '256';
    process.env.OPENSIP_CLI_WORKER_MAX_RSS_MB = '512';
    process.env.OPENSIP_CLI_WORKER_MAX_CONCURRENT_RPC = '3';
    process.env.OPENSIP_CLI_WORKER_MAX_TOTAL_RPC = '9';
    process.env.OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS = '800';
    process.env.OPENSIP_CLI_WORKER_IDLE_RPC_MS = '250';
    process.env.OPENSIP_CLI_WORKER_MAX_CAPTURED_OUTPUT_BYTES = '2048';
    process.env.OPENSIP_CLI_WORKER_STDERR_INHERIT = '1';
    const limits = getWorkerLimits();
    expect(limits).toMatchObject({
      timeoutMs: 5000,
      maxIpcBytes: 4096,
      maxOldSpaceMb: 256,
      maxRssMb: 512,
      maxConcurrentRpc: 3,
      maxTotalRpc: 9,
      heartbeatGraceMs: 800,
      idleRpcMs: 250,
      maxCapturedOutputBytes: 2048,
    });
    expect(workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_TIMEOUT_MS')).toBe(5000);
    expect(workerLimitsEnv.get<boolean>('OPENSIP_CLI_WORKER_STDERR_INHERIT')).toBe(true);
    expect(workerExecArgv(limits)).toEqual(['--max-old-space-size=256']);
  });

  it('falls back on invalid values and omits empty optional idle timeout', () => {
    process.env.OPENSIP_CLI_WORKER_TIMEOUT_MS = '0';
    process.env.OPENSIP_CLI_WORKER_MAX_IPC_BYTES = 'nope';
    process.env.OPENSIP_CLI_WORKER_IDLE_RPC_MS = '';
    expect(getWorkerLimits()).toMatchObject({
      timeoutMs: 120_000,
      maxIpcBytes: 32 * 1024 * 1024,
    });
    expect(getWorkerLimits().idleRpcMs).toBeUndefined();

    process.env.OPENSIP_CLI_WORKER_IDLE_RPC_MS = '-1';
    expect(getWorkerLimits().idleRpcMs).toBeUndefined();
  });
});
