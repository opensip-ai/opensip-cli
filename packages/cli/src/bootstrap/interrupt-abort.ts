/**
 * Host-owned OS interrupt → root AbortSignal coordinator (Plan 00 Phase 4).
 *
 * Single SIGINT/SIGTERM registration at the executable composition root.
 * First interrupt aborts the per-invocation root controller and starts a
 * grace timer; second interrupt (or grace expiry) forces process exit with
 * POSIX 130/143. Registering a SIGTERM/SIGINT listener removes Node's default
 * terminate action, so the grace timer is required for single-signal
 * supervisors (CI, pack smoke) to still converge.
 *
 * Both edges are logged (`cli.interrupt.received` on the first interrupt,
 * `cli.interrupt.force_exit` before a forced exit) so a run's log shows it was
 * interrupted rather than crashed or exited cleanly. The logger's file sink is a
 * synchronous append, so the force-exit record survives the immediate exit.
 */

import { createCancelledError, currentLogger } from '@opensip-cli/core';

const SECOND_INTERRUPT_WINDOW_MS = 2000;
const INTERRUPT_MODULE = 'interrupt-abort';

/** Why the process is being force-terminated (for the interrupt log record). */
type ForceExitCause = 'second-interrupt' | 'grace-timeout';

export type InterruptSignal = 'SIGINT' | 'SIGTERM';

export interface InterruptAbortCoordinator {
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  dispose: () => void;
}

export interface InstallInterruptAbortOptions {
  /** Called on first interrupt after abort (register MCP/child cleanup). */
  readonly onFirstInterrupt?: (signal: InterruptSignal) => void;
  /** Window for second-interrupt / grace force exit. Default 2000ms. */
  readonly secondInterruptWindowMs?: number;
}

let activeCoordinator: InterruptAbortCoordinator | undefined;

/** Current process-wide interrupt signal for this CLI invocation, if installed. */
export function getActiveInterruptSignal(): AbortSignal | undefined {
  return activeCoordinator?.signal;
}

function forceExitCode(name: InterruptSignal): number {
  return name === 'SIGTERM' ? 143 : 130;
}

function forceExit(name: InterruptSignal, cause: ForceExitCause): void {
  const code = forceExitCode(name);
  try {
    // Record the forced termination BEFORE exiting — the logger's file sink is a
    // synchronous appendFileSync, so this survives the immediate process.exit and
    // leaves a durable trace for troubleshooting (interrupted vs crashed vs clean).
    currentLogger().warn({
      evt: 'cli.interrupt.force_exit',
      module: INTERRUPT_MODULE,
      signal: name,
      exitCode: code,
      cause,
    });
  } catch {
    // Logging must never block the forced exit.
  }
  try {
    process.exitCode = code;
    // @fitness-ignore-next-line no-local-exit-or-stdout -- Process edge (Plan 00 §4.7): a SECOND SIGINT/SIGTERM within the grace window force-terminates a cooperative cancellation that did not complete; it must exit now (130/143), bypassing the possibly-stuck top-level boundary.
    process.exit(code);
  } catch {
    // ignore
  }
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
  let firstSignal: InterruptSignal | undefined;
  let disposed = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearGrace = () => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };

  const onSignal = (name: InterruptSignal) => {
    if (disposed) return;
    if (firstAt !== undefined) {
      // Second interrupt always escalates (even after the grace window), so a
      // hung process cannot ignore repeated Ctrl-C / SIGTERM once cancel started.
      clearGrace();
      forceExit(name, 'second-interrupt');
      return;
    }
    firstAt = Date.now();
    firstSignal = name;
    // Leave a durable, structured trace that the run was interrupted (vs crashed
    // or exited cleanly) — valuable when troubleshooting after the fact.
    try {
      currentLogger().warn({
        evt: 'cli.interrupt.received',
        module: INTERRUPT_MODULE,
        signal: name,
        action: 'aborting run; interrupt again or wait for the grace window to force-exit',
      });
    } catch {
      // Never let logging throw into the signal handler.
    }
    if (!controller.signal.aborted) {
      controller.abort(createCancelledError(`Received ${name}`));
    }
    try {
      options.onFirstInterrupt?.(name);
    } catch {
      // cleanup must not throw into the signal handler
    }
    // Single-signal supervisors: escalate after grace if cooperative cancel
    // does not exit the process first (Node no longer auto-exits once we listen).
    graceTimer = setTimeout(() => {
      if (disposed) return;
      forceExit(firstSignal ?? name, 'grace-timeout');
    }, windowMs);
    // Do not keep the event loop alive solely for the grace timer.
    graceTimer.unref?.();
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
      clearGrace();
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
