/**
 * GraphView — stateful Ink component that drives the `graph` command
 * with a live checklist of pipeline stages.
 *
 * Mirrors the FitView pattern: Banner + RunHeader at the top stay
 * stable across phases; the body transitions from `loading` → `running`
 * (live checklist) → `done` (final unified report).
 *
 * Activated only on the default human-report path. The non-interactive
 * paths (`--json`, `--gate-save`, `--gate-compare`, `--report-to`,
 * `--packages`) go straight through executeGraph in cli/graph.ts and
 * never instantiate this view.
 */

import {
  buildUnifiedReportLines,
  GRAPH_STAGES,
  runGraph,
  type GraphProgressEvent,
  type GraphStage,
  type RunGraphResult,
} from '@opensip-tools/graph';
import { useApp, Box, Text } from 'ink';
import React, { useState, useEffect, useCallback } from 'react';

import { useClock } from '../hooks/useClock.js';
import { useSpinner } from '../hooks/useSpinner.js';
import { useTheme } from '../theme.js';

import { Banner } from './Banner.js';
import { ErrorMessage } from './ErrorMessage.js';
import { RunHeader } from './RunHeader.js';

import type { DataStore } from '@opensip-tools/datastore';

interface GraphViewArgs {
  readonly cwd: string;
  readonly noCache?: boolean;
}

export interface GraphViewProps {
  readonly args: GraphViewArgs;
  readonly datastore?: DataStore;
}

type StageStatus =
  | { kind: 'pending' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'done'; durationMs: number; detail?: string }
  | { kind: 'cached' };

type StageMap = Readonly<Record<GraphStage, StageStatus>>;

const STAGE_LABELS: Readonly<Record<GraphStage, string>> = {
  discover: 'Discover files',
  parse: 'Parse project',
  walk: 'Walk catalog',
  resolve: 'Resolve call sites',
  index: 'Build indexes',
  rules: 'Evaluate rules',
};

const STAGE_RUNNING_DETAIL: Readonly<Record<GraphStage, string>> = {
  discover: 'Scanning source tree...',
  parse: 'Building program AST...',
  walk: 'Walking files for occurrences...',
  resolve: 'Binding symbols to edges...',
  index: 'Computing reverse indexes...',
  rules: 'Evaluating rule set...',
};

type ViewState =
  | { phase: 'loading' }
  | { phase: 'running'; stages: StageMap }
  | { phase: 'done'; stages: StageMap; reportLines: readonly string[] }
  | { phase: 'error'; message: string };

function initialStages(): Record<GraphStage, StageStatus> {
  const out = {} as Record<GraphStage, StageStatus>;
  for (const stage of GRAPH_STAGES) out[stage] = { kind: 'pending' };
  return out;
}

export function GraphView({ args, datastore }: GraphViewProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<ViewState>({ phase: 'loading' });

  const onProgress = useCallback((event: GraphProgressEvent) => {
    setState((prev) => {
      const base: Record<GraphStage, StageStatus> = prev.phase === 'running'
        ? { ...prev.stages }
        : initialStages();
      if (event.type === 'stage-start') {
        base[event.stage] = { kind: 'running', startedAt: Date.now() };
      } else if (event.type === 'stage-done') {
        base[event.stage] = {
          kind: 'done',
          durationMs: event.durationMs ?? 0,
          detail: event.detail,
        };
      } else {
        base[event.stage] = { kind: 'cached' };
      }
      return { phase: 'running', stages: base };
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState({ phase: 'running', stages: initialStages() });
      try {
        const result: RunGraphResult = await runGraph({
          cwd: args.cwd,
          noCache: args.noCache,
          onProgress,
          datastore,
        });
        if (cancelled) return;
        const reportLines = buildUnifiedReportLines({
          catalog: result.catalog,
          indexes: result.indexes,
          signals: result.signals,
          cacheHit: result.cacheHit,
        });
        setState((prev) => ({
          phase: 'done',
          stages: prev.phase === 'running' ? prev.stages : initialStages(),
          reportLines,
        }));
        setTimeout(() => exit(), 50);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ phase: 'error', message });
        process.exitCode = 1;
        setTimeout(() => exit(), 50);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const header = (
    <>
      <Banner />
      <RunHeader
        tool="Code Graph"
        description="Building call-graph from source"
        cwd={args.cwd}
      />
    </>
  );

  if (state.phase === 'error') {
    return (
      <Box flexDirection="column">
        {header}
        <ErrorMessage message={state.message} />
      </Box>
    );
  }

  if (state.phase === 'loading') {
    return (
      <Box flexDirection="column">
        {header}
        <Box paddingLeft={2} paddingTop={1}>
          <Text dimColor>Initializing pipeline...</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {header}
      <StageChecklist stages={state.stages} />
      {state.phase === 'done' && (
        <Box flexDirection="column" paddingTop={1}>
          {state.reportLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

interface ChecklistProps {
  readonly stages: StageMap;
}

function StageChecklist({ stages }: ChecklistProps): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      {GRAPH_STAGES.map((stage) => (
        <StageLine key={stage} stage={stage} status={stages[stage]} />
      ))}
    </Box>
  );
}

interface StageLineProps {
  readonly stage: GraphStage;
  readonly status: StageStatus;
}

function StageLine({ stage, status }: StageLineProps): React.ReactElement {
  const theme = useTheme();
  const label = STAGE_LABELS[stage];

  if (status.kind === 'pending') {
    return (
      <Text dimColor>
        {'  '}<Text>○</Text> {label}
      </Text>
    );
  }

  if (status.kind === 'cached') {
    return (
      <Text>
        <Text color={theme.success}>✓</Text>{' '}
        <Text>{label}</Text>{'   '}
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
        <Text>{label}</Text>{'   '}
        <Text dimColor>{detail}</Text>
      </Text>
    );
  }

  return <RunningStageLine stage={stage} startedAt={status.startedAt} label={label} />;
}

interface RunningStageLineProps {
  readonly stage: GraphStage;
  readonly startedAt: number;
  readonly label: string;
}

function RunningStageLine({ stage, startedAt, label }: RunningStageLineProps): React.ReactElement {
  const theme = useTheme();
  const frame = useSpinner();
  // Subscribe to the clock so this row re-renders on each tick; derive
  // wall-clock elapsed from Date.now() so it stays accurate regardless
  // of how many ticks have fired since startedAt.
  useClock();
  const elapsed = formatDuration(Date.now() - startedAt);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={theme.brand}>{frame}</Text>{' '}
        <Text bold>{label}</Text>
      </Text>
      <Text>
        {'    └─ '}
        <Text dimColor>{STAGE_RUNNING_DETAIL[stage]}</Text>{' '}
        <Text dimColor>({elapsed})</Text>
      </Text>
    </Box>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
