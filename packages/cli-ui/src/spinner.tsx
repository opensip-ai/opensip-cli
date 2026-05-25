/**
 * Spinner — animated progress indicator. Renders one braille frame per tick
 * plus an optional `completed/total (pct%)` suffix.
 *
 * Two modes:
 *  - Inside a `<ClockProvider>`: consumes the provider's tick via
 *    `useClock()`. Multiple spinners share the same timer.
 *  - Outside a provider (default): owns its own interval via `useTick()`.
 *    Convenient for single-spinner screens where setting up a provider
 *    is unnecessary.
 */

import { Text } from 'ink';
import React from 'react';

import { useClock, useTick } from './clock.js';
import { useTheme } from './theme.js';

const SPINNER_FRAMES = [
  '⠋', '⠙', '⠹', '⠸',
  '⠼', '⠴', '⠦', '⠧',
  '⠇', '⠏',
];

/** Spinner frame keyed off the surrounding `<ClockProvider>`. */
export function useSpinner(): string {
  const tick = useClock();
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? '';
}

/** Spinner frame from a self-owned interval — provider-free. */
export function useStandaloneSpinner(intervalMs?: number): string {
  const tick = useTick(intervalMs);
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? '';
}

export interface SpinnerProps {
  readonly total: number;
  readonly completed: number;
  readonly label?: string;
  /**
   * When true, the spinner uses its own internal tick instead of consuming
   * a `<ClockProvider>`. Useful for tool runners that don't want to wrap
   * their tree in a provider for a single spinner.
   */
  readonly standalone?: boolean;
}

export function Spinner({ total, completed, label = 'Running...', standalone = false }: SpinnerProps): React.ReactElement {
  return standalone
    ? <SpinnerStandalone total={total} completed={completed} label={label} />
    : <SpinnerCtx total={total} completed={completed} label={label} />;
}

function SpinnerCtx({ total, completed, label }: { readonly total: number; readonly completed: number; readonly label: string }): React.ReactElement {
  const theme = useTheme();
  const frame = useSpinner();
  return <SpinnerLine frame={frame} brand={theme.brand} total={total} completed={completed} label={label} />;
}

function SpinnerStandalone({ total, completed, label }: { readonly total: number; readonly completed: number; readonly label: string }): React.ReactElement {
  const theme = useTheme();
  const frame = useStandaloneSpinner();
  return <SpinnerLine frame={frame} brand={theme.brand} total={total} completed={completed} label={label} />;
}

function SpinnerLine({ frame, brand, total, completed, label }: { readonly frame: string; readonly brand: string; readonly total: number; readonly completed: number; readonly label: string }): React.ReactElement {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <Text>
      <Text color={brand}>{frame}</Text>
      {' '}
      {label}
      {total > 0 ? <Text>  {completed}/{total} ({pct}%)</Text> : null}
    </Text>
  );
}
