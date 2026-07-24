/**
 * Host-owned OS interrupt → root AbortSignal coordinator (Plan 00 Phase 4).
 *
 * Single SIGINT/SIGTERM registration at the executable composition root.
 * First interrupt aborts the per-invocation root controller; second within
 * the grace window forces process exit with POSIX 130/143.
 */

import { createCancelledError } from '@opensip-cli/core';

const SECOND_INTERRUPT_WINDOW_MS = 2000;

export type InterruptSignal = 'SIGINT' | 'SIGTERM';

export interface InterruptAbortCoordinator {
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  dispose: () => void;
}

export interface InstallInterruptAbortOptions {
  /** Called on first interrupt after abort (register MCP/child cleanup). */
  readonly onFirstInterrupt?: (signal: InterruptSignal) => void;
  /** Window for second-interrupt force exit. Default 2000ms. */
  readonly secondInterruptWindowMs?: number;
}

let activeCoordinator: InterruptAbortCoordinator | undefined;

/** Current process-wide interrupt signal for this CLI invocation, if installed. */
export function getActiveInterruptSignal(): AbortSignal | undefined {
  return activeCoordinator?.signal;
}

/**
 * Install one SIGINT/SIGTERM coordinator. Returns controller + dispose.
 * Idempotent per process for listeners only when dispose is called between runs.
 */
export function installInterruptAbortCoordinator(
  options: InstallInterruptAbortOptions = {},
): InterruptAbortCoordinator {
  // Replace previous coordinator if any (tests / nested invocations).
  activeCoordinator?.dispose();

  const controller = new AbortController();
  const windowMs = options.secondInterruptWindowMs ?? SECOND_INTERRUPT_WINDOW_MS;
  let firstAt: number | undefined;
  let disposed = false;

  const onSignal = (name: InterruptSignal) => {
    if (disposed) return;
    const now = Date.now();
    if (firstAt !== undefined && now - firstAt <= windowMs) {
      const code = name === 'SIGTERM' ? 143 : 130;
      try {
        process.exitCode = code;
        process.exit(code);
      } catch {
        // ignore
      }
      return;
    }
    firstAt = now;
    if (!controller.signal.aborted) {
      controller.abort(createCancelledError(`Received ${name}`));
    }
    try {
      options.onFirstInterrupt?.(name);
    } catch {
      // cleanup must not throw into the signal handler
    }
  };

  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const coordinator: InterruptAbortCoordinator = {
    signal: controller.signal,
    controller,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      if (activeCoordinator === coordinator) {
        activeCoordinator = undefined;
      }
    },
  };
  activeCoordinator = coordinator;
  return coordinator;
}
