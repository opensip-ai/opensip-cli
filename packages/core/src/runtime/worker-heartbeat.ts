/**
 * Worker heartbeat sender — small liveness pulse for forked IPC workers.
 */

import { sendWorkerIpcMessage } from './worker-ipc-send.js';

/** IPC liveness pulse emitted by forked workers to their supervisor. */
export interface WorkerHeartbeatMessage {
  readonly kind: 'heartbeat';
}

/** Configuration hooks for {@link startWorkerHeartbeat}. */
export interface WorkerHeartbeatOptions {
  readonly intervalMs?: number;
  readonly send?: (msg: WorkerHeartbeatMessage) => void;
}

/**
 * Emit periodic heartbeat IPC messages while a worker is alive.
 *
 * A send failure means the parent IPC channel is closing or the worker limit cap
 * is already firing; swallow it and let the supervisor's liveness timer settle.
 */
export function startWorkerHeartbeat(options: WorkerHeartbeatOptions = {}): () => void {
  if (process.send === undefined && options.send === undefined) {
    return () => {
      /* not forked */
    };
  }
  const send = options.send ?? sendWorkerIpcMessage;
  const timer = setInterval(() => {
    try {
      send({ kind: 'heartbeat' });
    } catch {
      // @swallow-ok supervisor will observe a closed/missed heartbeat channel
    }
  }, options.intervalMs ?? 10_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
