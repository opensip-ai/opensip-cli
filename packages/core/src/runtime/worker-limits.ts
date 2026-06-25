/**
 * WorkerLimits — governed resource ceilings for IPC worker `fork()` paths
 * (ADR-0054 dispatch supervisor + ADR-0028 live-engine subprocess transport).
 *
 * Every knob is env-tunable via {@link WORKER_LIMITS_ENV_SPECS} and read ONLY
 * through {@link workerLimitsEnv} (the `env-via-registry` guardrail).
 */

import { EnvRegistry } from '../lib/env-registry.js';

/** Resolved resource ceilings for one forked worker run. */
export interface WorkerLimits {
  /** Per-run wall-clock hard cap (ms). NOT reset per RPC. */
  readonly timeoutMs: number;
  /** Max serialized IPC payload bytes (send + receive). */
  readonly maxIpcBytes: number;
  /** V8 old-space cap injected via fork `execArgv` (`--max-old-space-size`). */
  readonly maxOldSpaceMb: number;
  /** Hard RSS ceiling sampled from the child pid (watchdog SIGKILL). */
  readonly maxRssMb: number;
  /** Max concurrent in-flight host-RPC upcalls (dispatch path). */
  readonly maxConcurrentRpc: number;
  /** Max total host-RPC upcalls per run (dispatch path). */
  readonly maxTotalRpc: number;
  /** Grace period after the last heartbeat before `heartbeat_missed` kill (ms). */
  readonly heartbeatGraceMs: number;
  /**
   * Optional per-upcall idle timer (ms). Off when unset — the per-run hard cap
   * is never extended by RPC traffic.
   */
  readonly idleRpcMs?: number;
  /** Max serialized bytes for ResultAccumulator fields + captured stderr. */
  readonly maxCapturedOutputBytes: number;
}

const MIB = 1024 * 1024;

function parsePositiveInt(raw: string, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseOptionalPositiveInt(raw: string): number | undefined {
  if (raw.length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Env specs for worker resource ceilings (DD9). */
export const WORKER_LIMITS_ENV_SPECS = [
  {
    canonical: 'OPENSIP_CLI_WORKER_TIMEOUT_MS',
    coerce: (raw: string) => parsePositiveInt(raw, 120_000),
    default: 120_000,
    docs: 'Per-run wall-clock hard cap for a forked worker (ms). Not reset per host-RPC upcall.',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_MAX_IPC_BYTES',
    coerce: (raw: string) => parsePositiveInt(raw, 32 * MIB),
    default: 32 * MIB,
    docs: 'Max serialized IPC payload size (bytes) on worker send and host receive.',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_MAX_OLD_SPACE_MB',
    coerce: (raw: string) => parsePositiveInt(raw, 4096),
    default: 4096,
    docs: 'V8 old-space cap for forked workers via --max-old-space-size (MiB).',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_MAX_RSS_MB',
    coerce: (raw: string) => parsePositiveInt(raw, 6144),
    default: 6144,
    docs: 'Hard RSS ceiling for forked workers; exceeded → SIGKILL (MiB).',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_MAX_CONCURRENT_RPC',
    coerce: (raw: string) => parsePositiveInt(raw, 1),
    default: 1,
    docs: 'Max concurrent in-flight host-RPC upcalls per dispatch worker run.',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_MAX_TOTAL_RPC',
    coerce: (raw: string) => parsePositiveInt(raw, 5000),
    default: 5000,
    docs: 'Max total host-RPC upcalls per dispatch worker run.',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS',
    coerce: (raw: string) => parsePositiveInt(raw, 60_000),
    default: 60_000,
    docs: 'Grace period after the last worker heartbeat before heartbeat_missed kill (ms).',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_IDLE_RPC_MS',
    coerce: (raw: string) => parseOptionalPositiveInt(raw),
    docs: 'Optional per-upcall idle timer (ms). Off when unset. Does NOT extend the per-run wall-clock cap.',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_MAX_CAPTURED_OUTPUT_BYTES',
    coerce: (raw: string) => parsePositiveInt(raw, 32 * MIB),
    default: 32 * MIB,
    docs: 'Max bytes for ResultAccumulator serialized output and captured child stderr.',
  },
  {
    canonical: 'OPENSIP_CLI_WORKER_STDERR_INHERIT',
    coerce: (raw: string) => raw === '1',
    default: false,
    docs: 'Set to 1 to inherit child stderr to the host terminal (debugging). Default captures a size-capped stderr tail on failure.',
  },
] as const;

/** Registry for worker limit env reads. */
export const workerLimitsEnv = new EnvRegistry([...WORKER_LIMITS_ENV_SPECS]);

/** Resolve the current worker limits from env (with safe defaults). */
export function getWorkerLimits(overrides?: Partial<WorkerLimits>): WorkerLimits {
  const idleRpcMs = workerLimitsEnv.get<number | undefined>('OPENSIP_CLI_WORKER_IDLE_RPC_MS');
  return {
    timeoutMs: workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_TIMEOUT_MS') ?? 120_000,
    maxIpcBytes: workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_MAX_IPC_BYTES') ?? 32 * MIB,
    maxOldSpaceMb: workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_MAX_OLD_SPACE_MB') ?? 4096,
    maxRssMb: workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_MAX_RSS_MB') ?? 6144,
    maxConcurrentRpc: workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_MAX_CONCURRENT_RPC') ?? 1,
    maxTotalRpc: workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_MAX_TOTAL_RPC') ?? 5000,
    heartbeatGraceMs:
      workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS') ?? 60_000,
    ...(idleRpcMs === undefined ? {} : { idleRpcMs }),
    maxCapturedOutputBytes:
      workerLimitsEnv.get<number>('OPENSIP_CLI_WORKER_MAX_CAPTURED_OUTPUT_BYTES') ?? 32 * MIB,
    ...overrides,
  };
}

/** Build fork execArgv for the V8 old-space cap. */
export function workerExecArgv(limits: WorkerLimits): readonly string[] {
  return [`--max-old-space-size=${String(limits.maxOldSpaceMb)}`];
}
