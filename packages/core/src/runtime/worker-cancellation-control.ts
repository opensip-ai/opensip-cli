/** Parent/worker cancellation control protocol (Plan 00 Phase 5). */

import { sendWorkerIpcMessageAndDrain } from './worker-ipc-send.js';

/** Version of the tiny cancel-request/cancel-ack control wire. */
export const WORKER_CONTROL_WIRE_VERSION = 1;

function isCancelRequest(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  try {
    const kind = Object.getOwnPropertyDescriptor(message, 'kind');
    const version = Object.getOwnPropertyDescriptor(message, 'controlVersion');
    return (
      kind !== undefined &&
      'value' in kind &&
      kind.value === 'cancel-request' &&
      version !== undefined &&
      'value' in version &&
      version.value === WORKER_CONTROL_WIRE_VERSION
    );
  } catch {
    // @swallow-ok probe/optional capability: malformed or hostile IPC messages are not cancellation requests.
    return false;
  }
}

/**
 * Install the worker side of cooperative cancellation. One valid request emits
 * one acknowledgement, then delivers SIGTERM to the worker's host-owned root
 * interrupt coordinator. The parent retains a bounded SIGKILL backstop.
 */
export function startWorkerCancellationControl(): () => void {
  let cancelled = false;
  const onMessage = (message: unknown): void => {
    if (cancelled || !isCancelRequest(message)) return;
    cancelled = true;
    void sendWorkerIpcMessageAndDrain({
      kind: 'cancel-ack',
      controlVersion: WORKER_CONTROL_WIRE_VERSION,
    })
      .catch(() => {
        // @swallow-ok cleanup/observer isolation: the parent may have closed IPC;
        // local SIGTERM and the parent hard-kill backstop remain authoritative.
      })
      .finally(() => {
        try {
          process.kill(process.pid, 'SIGTERM');
        } catch {
          // @swallow-ok cleanup/observer isolation: parent escalation remains authoritative.
        }
      });
  };
  process.on('message', onMessage);
  return () => process.removeListener('message', onMessage);
}
