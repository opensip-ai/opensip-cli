import { runInterruptCleanups } from './runner/interrupt-cleanup.js';

export type AgentEvalFatalKind = 'uncaughtException' | 'unhandledRejection';
export type AgentEvalTerminationSignal = 'SIGINT' | 'SIGTERM';

type BoundaryEvent = AgentEvalFatalKind | AgentEvalTerminationSignal;
type BoundaryListener = (...arguments_: unknown[]) => void;

export interface AgentEvalProcessBoundaryEffects {
  readonly addListener: (event: BoundaryEvent, listener: BoundaryListener) => void;
  readonly forceExit: (code: number) => void;
  readonly removeListener: (event: BoundaryEvent, listener: BoundaryListener) => void;
  readonly rerRaiseSignal: (signal: AgentEvalTerminationSignal) => void;
  readonly restoreDefaultSignal: (signal: AgentEvalTerminationSignal) => void;
}

export type AgentEvalFatalReporter = (reason: unknown, kind: AgentEvalFatalKind) => number;

function defaultProcessBoundaryEffects(): AgentEvalProcessBoundaryEffects {
  // Capture the real process primitives at installation time. A command-level
  // test guard installed later must not be able to defeat this safety net.
  const forceExit = process.exit.bind(process);
  const kill = process.kill.bind(process);
  return {
    addListener: (event, listener) => process.on(event, listener),
    forceExit: (code) => forceExit(code),
    removeListener: (event, listener) => process.off(event, listener),
    rerRaiseSignal: (signal) => {
      kill(process.pid, signal);
    },
    restoreDefaultSignal: (signal) => process.removeAllListeners(signal),
  };
}

/**
 * Install the direct-invocation-only signal and fatal boundary for agent-eval.
 * Signals restore their default disposition and are re-raised, preserving
 * signal-shaped exit status; fatal escapes receive one bounded report and exit.
 */
export function installAgentEvalProcessBoundary(
  reportFatal: AgentEvalFatalReporter,
  effects: AgentEvalProcessBoundaryEffects = defaultProcessBoundaryEffects(),
): () => void {
  let terminating = false;

  const onFatal = (kind: AgentEvalFatalKind, reason: unknown): void => {
    if (terminating) return;
    terminating = true;
    runInterruptCleanups();
    let exitCode = 1;
    try {
      exitCode = reportFatal(reason, kind);
    } catch {
      // Reporting is best-effort at this last-resort boundary.
    }
    effects.forceExit(exitCode);
  };

  const onSignal = (signal: AgentEvalTerminationSignal): void => {
    if (terminating) return;
    terminating = true;
    runInterruptCleanups();
    effects.restoreDefaultSignal(signal);
    try {
      effects.rerRaiseSignal(signal);
    } catch {
      effects.forceExit(signal === 'SIGINT' ? 130 : 143);
    }
  };

  const listeners: Readonly<Record<BoundaryEvent, BoundaryListener>> = {
    SIGINT: () => onSignal('SIGINT'),
    SIGTERM: () => onSignal('SIGTERM'),
    uncaughtException: (error) => onFatal('uncaughtException', error),
    unhandledRejection: (reason) => onFatal('unhandledRejection', reason),
  };

  for (const [event, listener] of Object.entries(listeners) as readonly [
    BoundaryEvent,
    BoundaryListener,
  ][]) {
    effects.addListener(event, listener);
  }

  return () => {
    for (const [event, listener] of Object.entries(listeners) as readonly [
      BoundaryEvent,
      BoundaryListener,
    ][]) {
      effects.removeListener(event, listener);
    }
  };
}
