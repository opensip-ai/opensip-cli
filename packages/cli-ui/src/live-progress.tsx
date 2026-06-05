/**
 * LiveProgress — the single live-run renderer shared by fit, graph, and sim
 * (ADR-0016). Replaces graph's bespoke StageChecklist/StageLine/RunningStageLine
 * and fit's inline Spinner wiring with one component driven by the
 * {@link ProgressEvent} stream.
 *
 * Two presentation modes, chosen by the {@link ProgressSurface}:
 *   - `phases` → a checklist: ✓ done rows (label + detail + duration), `(cached)`
 *     rows, an active spinner row with a dim running sub-label + live elapsed, and
 *     ○ dim pending rows. (Visual ported verbatim from graph's former checklist.)
 *   - `pool` → the existing `<Spinner>` (frame + label + `completed/total (pct%)`).
 *
 * Presentational only: `useProgressState` folds the event stream into render
 * state so the tool runners stay thin (they just wire `transport.onProgress`).
 * Must be mounted inside a `<ThemeProvider>` + `<ClockProvider>` (the tool
 * runners already provide both).
 */

import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

import { formatDuration } from './format-duration.js';
import { Spinner, useSpinner } from './spinner.js';
import { useTheme } from './theme.js';

import type {
  ProgressCallback,
  ProgressEvent,
  ProgressStageDescriptor,
  ProgressSurface,
} from './progress-event.js';

// ---------------------------------------------------------------------------
// Reduced render state
// ---------------------------------------------------------------------------

type PhaseStatus =
  | { readonly kind: 'pending' }
  | { readonly kind: 'running'; readonly startedAt: number }
  | { readonly kind: 'done'; readonly durationMs: number; readonly detail?: string }
  | { readonly kind: 'cached' };

interface PhasesState {
  readonly shape: 'phases';
  readonly stages: readonly ProgressStageDescriptor[];
  readonly status: Readonly<Record<string, PhaseStatus>>;
}

interface PoolState {
  readonly shape: 'pool';
  readonly label: string;
  readonly completed: number;
  readonly total: number;
}

type ProgressState = PhasesState | PoolState;

function initState(surface: ProgressSurface): ProgressState {
  if (surface.shape === 'pool') {
    return { shape: 'pool', label: surface.label, completed: 0, total: 0 };
  }
  const status: Record<string, PhaseStatus> = {};
  for (const s of surface.stages) status[s.id] = { kind: 'pending' };
  return { shape: 'phases', stages: surface.stages, status };
}

function reduce(prev: ProgressState, event: ProgressEvent): ProgressState {
  if (prev.shape === 'pool') {
    if (event.type === 'stage-progress') {
      return { ...prev, completed: event.completed, total: event.total };
    }
    return prev;
  }
  // phases
  const next: Record<string, PhaseStatus> = { ...prev.status };
  switch (event.type) {
    case 'stage-start': {
      next[event.stage] = { kind: 'running', startedAt: Date.now() };
      break;
    }
    case 'stage-done': {
      next[event.stage] = { kind: 'done', durationMs: event.durationMs, detail: event.detail };
      break;
    }
    case 'stage-cached': {
      next[event.stage] = { kind: 'cached' };
      break;
    }
    case 'stage-progress': {
      break; // phases mode ignores pool counters
    }
  }
  return { ...prev, status: next };
}

/**
 * Subscribe to a transport's event stream and fold it into render state. The
 * `subscribe` function is the transport's `onProgress`; it is called exactly
 * once on mount (the transport buffers any events emitted before subscription
 * and flushes them on attach, so none are lost).
 */
export function useProgressState(
  surface: ProgressSurface,
  subscribe: (cb: ProgressCallback) => void,
): ProgressState {
  const [state, setState] = useState<ProgressState>(() => initState(surface));
  // Subscribe once on mount — the transport owns the listener lifetime and
  // buffers/flushes any events emitted before this effect runs.
  useEffect(() => {
    subscribe((event) => setState((prev) => reduce(prev, event)));
  }, []);
  return state;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface LiveProgressProps {
  readonly surface: ProgressSurface;
  readonly subscribe: (cb: ProgressCallback) => void;
}

export function LiveProgress({ surface, subscribe }: LiveProgressProps): React.ReactElement {
  const state = useProgressState(surface, subscribe);
  if (state.shape === 'pool') {
    return (
      <Box paddingLeft={2}>
        <Spinner total={state.total} completed={state.completed} label={state.label} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      {state.stages.map((stage) => (
        <PhaseLine key={stage.id} stage={stage} status={state.status[stage.id] ?? { kind: 'pending' }} />
      ))}
    </Box>
  );
}

function PhaseLine({
  stage,
  status,
}: {
  readonly stage: ProgressStageDescriptor;
  readonly status: PhaseStatus;
}): React.ReactElement {
  const theme = useTheme();

  if (status.kind === 'pending') {
    return (
      <Text dimColor>
        {'  '}<Text>○</Text> {stage.label}
      </Text>
    );
  }

  if (status.kind === 'cached') {
    return (
      <Text>
        <Text color={theme.success}>✓</Text>{' '}
        <Text>{stage.label}</Text>{'   '}
        <Text dimColor>(cached)</Text>
      </Text>
    );
  }

  if (status.kind === 'done') {
    const dur = formatDuration(status.durationMs);
    const detail = status.detail ? `${status.detail} (${dur})` : dur;
    return (
      <Text>
        <Text color={theme.success}>✓</Text>{' '}
        <Text>{stage.label}</Text>{'   '}
        <Text dimColor>{detail}</Text>
      </Text>
    );
  }

  return <RunningPhaseLine stage={stage} startedAt={status.startedAt} />;
}

function RunningPhaseLine({
  stage,
  startedAt,
}: {
  readonly stage: ProgressStageDescriptor;
  readonly startedAt: number;
}): React.ReactElement {
  const theme = useTheme();
  const frame = useSpinner();
  // Re-render on each tick; derive wall-clock elapsed from Date.now() so it stays
  // accurate regardless of how many ticks fired since startedAt.
  const elapsed = formatDuration(Date.now() - startedAt);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.brand}>{frame}</Text>{' '}
        <Text bold>{stage.label}</Text>
      </Text>
      <Text>
        {'    └─ '}
        {stage.runningDetail ? <Text dimColor>{stage.runningDetail}{' '}</Text> : null}
        <Text dimColor>({elapsed})</Text>
      </Text>
    </Box>
  );
}
