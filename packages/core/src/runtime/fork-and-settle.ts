/**
 * forkAndSettle — shared fork + single-settle latch + kill-on-settle + tree-kill
 * + resource-limit timers for IPC worker paths (DD7).
 *
 * Two protocol-specific supervisors sit above this primitive:
 *   - dispatch-fork-core (RPC-reply direction)
 *   - subprocess-transport (fire-and-forget progress relay)
 */

import { fork, type ChildProcess } from 'node:child_process';

import { isIpcPayloadTooLarge, measureIpcPayloadBytes } from './ipc-payload.js';
import { killTree } from './kill-tree.js';
import { startRssWatchdog } from './rss-watchdog.js';
import { CapturedStderr } from './stderr-capture.js';
import {
  getWorkerLimits,
  workerExecArgv,
  workerLimitsEnv,
  type WorkerLimits,
} from './worker-limits.js';

/** Context passed to optional env-policy hooks (Spec 03 coordination). */
export interface ForkEnvContext {
  readonly runId?: string;
}

/** Declarative input for a forked IPC worker supervised by {@link forkAndSettle}. */
export interface ForkAndSettleDescriptor {
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly buildChildEnv?: (parentEnv: NodeJS.ProcessEnv, ctx: ForkEnvContext) => NodeJS.ProcessEnv;
  readonly limits?: Partial<WorkerLimits>;
  readonly timeoutMs?: number;
  readonly enableHeartbeat?: boolean;
  readonly enableSigintCancellation?: boolean;
  readonly onMessage?: (msg: unknown) => void;
  readonly onLimitFailure?: (failureClass: string, detail?: string) => void;
}

/** Runtime control surface returned to protocol-specific fork supervisors. */
export interface ForkAndSettleHandle {
  readonly child: ChildProcess;
  readonly isSettled: () => boolean;
  readonly done: (apply: () => void) => void;
  readonly killTree: (signal?: NodeJS.Signals | number) => void;
  readonly sendToChild: (msg: unknown) => boolean;
  readonly getStderrTail: () => string | undefined;
  readonly noteHeartbeat: () => void;
  readonly dispose: () => void;
}

function isHeartbeatMessage(msg: unknown): boolean {
  return (
    typeof msg === 'object' && msg !== null && (msg as { kind?: unknown }).kind === 'heartbeat'
  );
}

function buildStdio(stderrInherit: boolean): ['ignore', 'ignore', 'inherit' | 'pipe', 'ipc'] {
  return ['ignore', 'ignore', stderrInherit ? 'inherit' : 'pipe', 'ipc'];
}

function resolveForkChildEnv(
  descriptor: ForkAndSettleDescriptor,
  ctx: ForkEnvContext,
): NodeJS.ProcessEnv | undefined {
  if (descriptor.buildChildEnv !== undefined) {
    return descriptor.buildChildEnv(process.env, ctx);
  }
  if (descriptor.env === undefined && ctx.runId === undefined) {
    return undefined;
  }
  // @fitness-ignore-next-line env-secret-exposure -- this env object is passed directly to fork(), never logged; callers that need stricter inheritance provide buildChildEnv.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (descriptor.env !== undefined) Object.assign(env, descriptor.env);
  if (ctx.runId !== undefined && ctx.runId.length > 0) {
    env.OPENSIP_RUN_ID = ctx.runId;
  }
  return env;
}

/**
 * Process-global SIGINT cancellation fan-out (plan 09 Task 5.5).
 *
 * One listener per PROCESS instead of one per concurrent child: >10 parallel
 * forks previously tripped Node's MaxListenersExceededWarning on every
 * parallel fit/graph run. This is process-lifecycle infrastructure (SIGINT is
 * delivered once per process — a RunScope-owned handler cannot exist), the
 * sanctioned singleton case peer to the pinned ALS container in run-scope.ts:
 * the Symbol.for slot keeps duplicate physical core copies
 * (injectWorkspacePackages) on ONE registry, it holds only opaque per-child
 * cancellation callbacks (never scope-derived data), and every child
 * unregisters on settle. The listener installs on the FIRST active child and
 * uninstalls on the LAST, so an idle process keeps Node's default Ctrl-C
 * termination exactly as before.
 */
interface SigintCancellationRegistry {
  readonly callbacks: Set<() => void>;
  handler: (() => void) | undefined;
}

const SIGINT_REGISTRY_SLOT = Symbol.for('@opensip-cli/core/sigintCancellationRegistry');

function sigintCancellationRegistry(): SigintCancellationRegistry {
  const holder = globalThis as Record<PropertyKey, unknown>;
  let registry = holder[SIGINT_REGISTRY_SLOT] as SigintCancellationRegistry | undefined;
  if (registry === undefined) {
    registry = { callbacks: new Set(), handler: undefined };
    holder[SIGINT_REGISTRY_SLOT] = registry;
  }
  return registry;
}

/** Register a child's cancellation; returns the unregister latch. */
function registerSigintCancellation(cancel: () => void): () => void {
  const registry = sigintCancellationRegistry();
  registry.callbacks.add(cancel);
  if (registry.handler === undefined) {
    registry.handler = (): void => {
      // Iterate a snapshot: a callback unregisters itself during fan-out.
      for (const callback of [...registry.callbacks]) {
        try {
          callback();
        } catch {
          /* @swallow-ok cancellation must reach every remaining child */
        }
      }
    };
    process.on('SIGINT', registry.handler);
  }
  let unregistered = false;
  return (): void => {
    if (unregistered) return;
    unregistered = true;
    registry.callbacks.delete(cancel);
    if (registry.callbacks.size === 0 && registry.handler !== undefined) {
      process.off('SIGINT', registry.handler);
      registry.handler = undefined;
    }
  };
}

/**
 * Fork a worker, enforce resource ceilings, and expose the single-settle latch.
 * The caller wires protocol-specific `message` handling via `descriptor.onMessage`.
 */
export function forkAndSettle(
  descriptor: ForkAndSettleDescriptor,
  ctx: ForkEnvContext = {},
): ForkAndSettleHandle {
  const limits = getWorkerLimits(descriptor.limits);
  const timeoutMs = descriptor.timeoutMs ?? limits.timeoutMs;
  const stderrInherit = workerLimitsEnv.get<boolean>('OPENSIP_CLI_WORKER_STDERR_INHERIT') === true;
  const stderrCapture = stderrInherit
    ? undefined
    : new CapturedStderr(limits.maxCapturedOutputBytes);

  const childEnv = resolveForkChildEnv(descriptor, ctx);

  const child = fork(descriptor.command, [...descriptor.argv], {
    cwd: descriptor.cwd,
    detached: true,
    stdio: buildStdio(stderrInherit),
    serialization: 'advanced',
    execArgv: [...workerExecArgv(limits)],
    ...(childEnv === undefined ? {} : { env: childEnv }),
  });

  if (stderrCapture !== undefined && child.stderr !== null) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderrCapture.append(chunk);
    });
  }

  let settled = false;
  let lastHeartbeatAt = Date.now();
  let timeoutTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let idleRpcTimer: NodeJS.Timeout | undefined;
  let unregisterSigint: (() => void) | undefined;

  const clearTimers = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    if (idleRpcTimer !== undefined) clearTimeout(idleRpcTimer);
    timeoutTimer = undefined;
    heartbeatTimer = undefined;
    idleRpcTimer = undefined;
  };

  const kill = (signal: NodeJS.Signals | number = 'SIGTERM'): void => {
    killTree(child, signal);
  };

  const done = (apply: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    rssWatchdog.stop();
    unregisterSigint?.();
    unregisterSigint = undefined;
    apply();
    kill();
  };

  const onLimit = (failureClass: string, detail?: string): void => {
    done(() => {
      descriptor.onLimitFailure?.(failureClass, detail);
    });
  };

  timeoutTimer = setTimeout(() => {
    kill('SIGKILL');
    onLimit('timeout', `worker timed out after ${String(timeoutMs)}ms`);
  }, timeoutMs);
  timeoutTimer.unref?.();

  if (descriptor.enableHeartbeat === true) {
    heartbeatTimer = setInterval(
      () => {
        if (settled) return;
        if (Date.now() - lastHeartbeatAt > limits.heartbeatGraceMs) {
          kill('SIGKILL');
          onLimit('heartbeat_missed');
        }
      },
      Math.min(5000, Math.max(1000, Math.floor(limits.heartbeatGraceMs / 4))),
    );
    heartbeatTimer.unref?.();
  }

  const resetIdleRpcTimer = (): void => {
    if (limits.idleRpcMs === undefined) return;
    if (idleRpcTimer !== undefined) clearTimeout(idleRpcTimer);
    idleRpcTimer = setTimeout(() => {
      kill('SIGKILL');
      onLimit('timeout', `host-RPC idle timer exceeded ${String(limits.idleRpcMs)}ms`);
    }, limits.idleRpcMs);
    idleRpcTimer.unref?.();
  };

  if (descriptor.enableSigintCancellation === true) {
    unregisterSigint = registerSigintCancellation(() => {
      kill('SIGKILL');
      onLimit('cancelled');
    });
  }

  const rssWatchdog = startRssWatchdog({
    child,
    maxRssMb: limits.maxRssMb,
    onExceeded: () => {
      onLimit('rss_exceeded');
    },
  });

  child.on('message', (msg: unknown) => {
    if (settled) return;

    if (isHeartbeatMessage(msg)) {
      lastHeartbeatAt = Date.now();
      return;
    }

    if (isIpcPayloadTooLarge(msg, limits.maxIpcBytes)) {
      kill('SIGKILL');
      onLimit(
        'payload_too_large',
        `${String(measureIpcPayloadBytes(msg))} > ${String(limits.maxIpcBytes)} bytes`,
      );
      return;
    }

    if (limits.idleRpcMs !== undefined) resetIdleRpcTimer();
    descriptor.onMessage?.(msg);
  });

  child.on('error', (err: Error) => {
    done(() => {
      descriptor.onLimitFailure?.('spawn', err.message);
    });
  });

  child.on('exit', () => {
    // Premature exit is handled by protocol supervisors via their own done() paths.
  });

  return {
    child,
    isSettled: () => settled,
    done,
    killTree: kill,
    sendToChild: (msg: unknown) => {
      if (settled || !child.connected) return false;
      if (isIpcPayloadTooLarge(msg, limits.maxIpcBytes)) {
        kill('SIGKILL');
        onLimit('payload_too_large');
        return false;
      }
      child.send(msg as Parameters<ChildProcess['send']>[0]);
      return true;
    },
    getStderrTail: () => stderrCapture?.tail(),
    noteHeartbeat: () => {
      lastHeartbeatAt = Date.now();
    },
    dispose: () => {
      if (!settled) {
        settled = true;
        clearTimers();
        rssWatchdog.stop();
        unregisterSigint?.();
        unregisterSigint = undefined;
        kill();
      }
    },
  };
}
