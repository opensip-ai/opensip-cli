/* eslint-disable unicorn/filename-case -- React `useXxx` hook convention; renaming to kebab-case obscures the hook role */
/**
 * Clock context — provides a tick counter that increments at a fixed interval.
 * Used by useSpinner and any other animation that needs a frame counter.
 */

import React, { useState, useEffect, createContext, useContext } from 'react';

const TICK_INTERVAL_MS = 80;

const ClockContext = createContext<number>(0);

export interface ClockProviderProps {
  readonly intervalMs?: number;
  readonly children: React.ReactNode;
}

export function ClockProvider({ intervalMs = TICK_INTERVAL_MS, children }: ClockProviderProps): React.ReactElement {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setTick((prev) => prev + 1);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return React.createElement(ClockContext.Provider, { value: tick }, children);
}

export function useClock(): number {
  return useContext(ClockContext);
}
