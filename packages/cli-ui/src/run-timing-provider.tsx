/**
 * RunTimingProvider + hooks — React context bridge for the host-owned
 * `RunTimer` (host-owned-run-timing plan).
 *
 * Live views (and any nested RunSummary) receive the *exact same* timer
 * instance that the host stamped into `ToolCliContext.runSession.timing` (and
 * forwarded via the optional `LiveViewContext` second arg to the renderer).
 *
 * This lets the UI read wall duration without tools threading numbers, and
 * ensures the persisted StoredSession.durationMs (from the host snapshot at
 * record time) and the final "Duration X" line agree.
 *
 * Usage in a live renderer:
 *   <RunTimingProvider timer={context.runSession.timing}>
 *     <RunSummary passed=... errors=... warnings=... />
 *   </RunTimingProvider>
 *
 * Components can omit durationMs and read from the provider.
 */

import React, { createContext, useContext, type ReactNode } from 'react';

import type { RunTimer } from '@opensip-cli/core';

const RunTimingContext = createContext<RunTimer | null>(null);

/** Props for the provider that wraps a live view subtree. */
export interface RunTimingProviderProps {
  /** The host timer from `cli.runSession.timing` (or LiveViewContext). */
  readonly timer: RunTimer;
  readonly children: ReactNode;
}

/**
 * Provides a `RunTimer` to descendants. Safe to nest; inner wins.
 * The timer is a stable object for the whole run — its `elapsedMs()` and
 * `snapshot()` are what produce live ticking + final recorded duration.
 */
export function RunTimingProvider({ timer, children }: RunTimingProviderProps) {
  return <RunTimingContext.Provider value={timer}>{children}</RunTimingContext.Provider>;
}

/**
 * Read the current host `RunTimer` (or null if no provider in tree).
 * Components should handle null (falls back to explicit prop or 0).
 */
export function useRunTiming(): RunTimer | null {
  return useContext(RunTimingContext);
}

/**
 * Convenience: current elapsed duration in ms.
 * - During a live run: reflects `timer.elapsedMs()` at render time (ticking UX).
 * - After done: a consumer can snapshot once and pass an explicit durationMs
 *   if they want a frozen completed value (see RunSummary).
 *
 * Returns 0 when no provider (safe default).
 */
export function useRunDuration(): number {
  const timer = useRunTiming();
  if (!timer) return 0;
  return timer.elapsedMs();
}
