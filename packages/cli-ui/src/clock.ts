/**
 * Clock context — provides a tick counter that increments at a fixed interval.
 * Used by useSpinner and any other animation that needs a frame counter.
 *
 * Two consumption shapes:
 *  - `<ClockProvider>` + `useClock()` — preferred when multiple components
 *    in the same tree need to share a single ticking timer (avoids N
 *    duplicate intervals).
 *  - `useTick()` — convenience hook that owns its own interval. Use when a
 *    single isolated component needs animation and pulling in a provider
 *    would be more setup than the component is worth.
 */

import { createContext, useContext, useEffect, useState, createElement } from 'react';

import type { ReactElement, ReactNode } from 'react';

const TICK_INTERVAL_MS = 80;

const ClockContext = createContext<number>(0);

/** Props for {@link ClockProvider}: tick interval (ms) and tree children. */
export interface ClockProviderProps {
  readonly intervalMs?: number;
  readonly children: ReactNode;
}

/** React provider that broadcasts a tick counter to descendants via {@link useClock}. */
export function ClockProvider({ intervalMs = TICK_INTERVAL_MS, children }: ClockProviderProps): ReactElement {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setTick((prev) => prev + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return createElement(ClockContext.Provider, { value: tick }, children);
}

/** Returns the current tick from the enclosing {@link ClockProvider} (or 0). */
export function useClock(): number {
  return useContext(ClockContext);
}

/**
 * Provider-free tick hook. Owns its own interval. Prefer `useClock()` inside
 * a `<ClockProvider>` when multiple components on the same screen animate.
 */
export function useTick(intervalMs: number = TICK_INTERVAL_MS): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick((prev) => prev + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}
