import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installAgentEvalProcessBoundary,
  type AgentEvalProcessBoundaryEffects,
} from './process-boundary.js';
import {
  registerInterruptCleanup,
  resetInterruptCleanupsForTests,
} from './runner/interrupt-cleanup.js';

type Listener = (...arguments_: unknown[]) => void;

function boundaryHarness(): {
  readonly effects: AgentEvalProcessBoundaryEffects;
  readonly forceExit: ReturnType<typeof vi.fn>;
  readonly listeners: Map<string, Listener>;
  readonly removed: string[];
  readonly rerRaiseSignal: ReturnType<typeof vi.fn>;
  readonly restored: string[];
} {
  const listeners = new Map<string, Listener>();
  const removed: string[] = [];
  const forceExit = vi.fn();
  const rerRaiseSignal = vi.fn();
  const restored: string[] = [];
  return {
    effects: {
      addListener: (event, listener) => listeners.set(event, listener),
      forceExit,
      removeListener: (event, listener) => {
        if (listeners.get(event) === listener) listeners.delete(event);
        removed.push(event);
      },
      rerRaiseSignal,
      restoreDefaultSignal: (signal) => {
        listeners.delete(signal);
        restored.push(signal);
      },
    },
    forceExit,
    listeners,
    removed,
    rerRaiseSignal,
    restored,
  };
}

afterEach(() => resetInterruptCleanupsForTests());

describe('agent-eval process boundary', () => {
  it('cleans live resources, restores the signal disposition, and re-raises once', () => {
    const harness = boundaryHarness();
    const events: string[] = [];
    registerInterruptCleanup(() => events.push('cleanup'));
    const uninstall = installAgentEvalProcessBoundary(
      vi.fn(() => 1),
      harness.effects,
    );

    harness.listeners.get('SIGINT')?.();
    harness.listeners.get('SIGTERM')?.();

    expect(events).toEqual(['cleanup']);
    expect(harness.restored).toEqual(['SIGINT']);
    expect(harness.rerRaiseSignal).toHaveBeenCalledOnce();
    expect(harness.rerRaiseSignal).toHaveBeenCalledWith('SIGINT');
    expect(harness.forceExit).not.toHaveBeenCalled();
    uninstall();
  });

  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    'reports and force-exits one escaped %s after cleanup',
    (kind) => {
      const harness = boundaryHarness();
      const events: string[] = [];
      const reason = new Error('escaped failure');
      const report = vi.fn(() => 1);
      registerInterruptCleanup(() => events.push('cleanup'));
      installAgentEvalProcessBoundary(report, harness.effects);

      harness.listeners.get(kind)?.(reason);
      harness.listeners.get(kind)?.(new Error('second failure'));

      expect(events).toEqual(['cleanup']);
      expect(report).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(reason, kind);
      expect(harness.forceExit).toHaveBeenCalledOnce();
      expect(harness.forceExit).toHaveBeenCalledWith(1);
    },
  );

  it('uses the conventional signal exit code if re-raise is unavailable', () => {
    const harness = boundaryHarness();
    installAgentEvalProcessBoundary(
      vi.fn(() => 1),
      {
        ...harness.effects,
        rerRaiseSignal: () => {
          throw new Error('signal unavailable');
        },
      },
    );

    harness.listeners.get('SIGTERM')?.();

    expect(harness.forceExit).toHaveBeenCalledWith(143);
  });
});
