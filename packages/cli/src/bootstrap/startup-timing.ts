import { performance } from 'node:perf_hooks';

export interface StartupTimingEvent {
  readonly name: string;
  readonly durationMs: number;
  readonly sinceStartMs: number;
  readonly skipped?: boolean;
}

export interface StartupTimer {
  readonly mark: (name: string, opts?: { readonly skipped?: boolean }) => void;
  readonly measure: <T>(name: string, fn: () => T) => T;
  readonly measureAsync: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  readonly events: () => readonly StartupTimingEvent[];
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

export function createStartupTimer(): StartupTimer {
  const startedAt = performance.now();
  const events: StartupTimingEvent[] = [];

  function push(name: string, phaseStartedAt: number, skipped?: boolean): void {
    const now = performance.now();
    events.push({
      name,
      durationMs: roundMs(now - phaseStartedAt),
      sinceStartMs: roundMs(now - startedAt),
      ...(skipped === true ? { skipped: true } : {}),
    });
  }

  return {
    mark: (name, opts) => {
      push(name, performance.now(), opts?.skipped);
    },
    measure: (name, fn) => {
      const phaseStartedAt = performance.now();
      try {
        return fn();
      } finally {
        push(name, phaseStartedAt);
      }
    },
    measureAsync: async (name, fn) => {
      const phaseStartedAt = performance.now();
      try {
        return await fn();
      } finally {
        push(name, phaseStartedAt);
      }
    },
    events: () => [...events],
  };
}
