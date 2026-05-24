/**
 * graph-runner — owns the live-view state machine for `opensip-tools graph`.
 *
 * Layer 5 Phase 3 lifted the graph live view out of `@opensip-tools/cli`.
 * The state machine (loading → running → done | error), `runGraph`
 * orchestration, `buildUnifiedReportLines` post-call, and the Ink/React
 * render tree live here, in the package that owns the graph command
 * surface. Adding a fourth tool with a live view requires zero CLI
 * edits — each tool ships its own renderer and registers it via
 * `cli.registerLiveView(key, renderer)`.
 *
 * The presentational primitives (banner, run header, stage checklist)
 * are inlined here using bare `Box`/`Text` from Ink. This file pays
 * the ~300-line cost of breaking the cli/ui → graph import edge that
 * previously forced cli/ui to be aware of `runGraph` and
 * `GraphProgressEvent`. Documented as F3 in
 * docs/plans/architecture/2026-05-22-plan-layer-5-cli.md.
 *
 * Single exit-code write path: error outcomes route through the
 * supplied `setExitCode` callback (`ToolCliContext.setExitCode`) so the
 * CLI keeps its only `process.exitCode` mutator. The historical
 * `process.exitCode = 1` write that lived in GraphView is gone.
 */

import { Box, Text, useApp, render } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

import { buildUnifiedReportLines } from './graph.js';
import { GRAPH_STAGES, runGraph } from './orchestrate.js';

import type { GraphProgressEvent, GraphStage, RunGraphResult } from './orchestrate.js';
import type { DataStore } from '@opensip-tools/datastore';

// ---------------------------------------------------------------------------
// Theme — minimal palette, mirrors @opensip-tools/cli's defaults so the
// live view looks the same as the static `cli.render(result)` path.
// ---------------------------------------------------------------------------

interface Theme {
  readonly brand: string;
  readonly success: string;
  readonly error: string;
}

const THEME: Theme = {
  brand: '#C8956C',
  success: 'green',
  error: 'red',
};

// ---------------------------------------------------------------------------
// Spinner clock
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = [
  '⠋', '⠙', '⠹', '⠸',
  '⠼', '⠴', '⠦', '⠧',
  '⠇', '⠏',
];
const TICK_INTERVAL_MS = 80;

function useTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick((prev) => prev + 1);
    }, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return tick;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

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

interface GraphRunnerArgs {
  readonly cwd: string;
  readonly noCache?: boolean;
}

interface GraphRunnerProps {
  readonly args: GraphRunnerArgs;
  readonly datastore?: DataStore;
  readonly setExitCode?: (code: number) => void;
}

function GraphRunner({ args, datastore, setExitCode }: GraphRunnerProps): React.ReactElement {
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
        setExitCode?.(1);
        setTimeout(() => exit(), 50);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const header = (
    <>
      <Banner />
      <RunHeader cwd={args.cwd} />
    </>
  );

  if (state.phase === 'error') {
    return (
      <Box flexDirection="column">
        {header}
        <ErrorLine message={state.message} />
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

// ---------------------------------------------------------------------------
// Inline visual primitives
// ---------------------------------------------------------------------------

const BANNER: readonly [string, string, string][] = [
  ['   ░       ░             ',  '  ██████   ████████  █████████ ████  ███', ' ███████   █████ ████████ '],
  ['    ░     ░              ',  ' ███░░░███░███░░░░██░███░░░░░░░░███  ███', '███░░░░███░░███ ░███░░░░██'],
  ['   ░       ░             ',  '███   ░███░███   ░██░███       ░████ ███', '░███   ░░░ ░███ ░███   ░██'],
  ['███████████████          ',  '███   ░███░████████░░██████    ░██░█████', '░░███████  ░███ ░████████░'],
  ['███████████████  █████   ',  '███   ░███░███░░░░  ░███░░░    ░██ ░████', ' ░░░░░░███ ░███ ░███░░░░  '],
  ['███████████████ ░░░░███  ',  '░███  ████░███      ░███       ░██  ░███', ' ███   ███ ░███ ░███      '],
  ['███████████████  █████   ',  ' ░██████░  ████      █████████ ████  ███', '░░███████  █████ ████     '],
  ['░█████████████░ ░░░      ',  '  ░░░░░░  ░░░░░     ░░░░░░░░░░░░░░  ░░░', ' ░░░░░░░  ░░░░░ ░░░░░     '],
];
const BANNER_SAUCER = ' ░███████████░';

function Banner(): React.ReactElement {
  return (
    <Box flexDirection="column">
      {BANNER.map(([cup, openPart, sipPart], i) => (
        <Text key={i}>
          {cup}
          <Text color={THEME.brand}>{openPart}</Text>
          {' '}
          <Text bold>{sipPart}</Text>
        </Text>
      ))}
      <Text>{BANNER_SAUCER}</Text>
    </Box>
  );
}

function RunHeader({ cwd }: { readonly cwd: string }): React.ReactElement {
  const separator = '─'.repeat(60);
  return (
    <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
      <Text bold color={THEME.brand}>Code Graph</Text>
      <Text dimColor>Target: {cwd}</Text>
      <Text> </Text>
      <Text dimColor>Building call-graph from source</Text>
      <Text> </Text>
      <Text dimColor>{separator}</Text>
    </Box>
  );
}

function ErrorLine({ message }: { readonly message: string }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color={THEME.error}>{'✗'}</Text>
        {' '}
        {message}
      </Text>
    </Box>
  );
}

function StageChecklist({ stages }: { readonly stages: StageMap }): React.ReactElement {
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
        <Text color={THEME.success}>✓</Text>{' '}
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
        <Text color={THEME.success}>✓</Text>{' '}
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
  const tick = useTick();
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  // Re-render on each tick; derive wall-clock elapsed from Date.now() so it
  // stays accurate regardless of how many ticks have fired since startedAt.
  const elapsed = formatDuration(Date.now() - startedAt);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={THEME.brand}>{frame}</Text>{' '}
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

// ---------------------------------------------------------------------------
// Public entry — registered with the CLI via `cli.registerLiveView('graph', ...)`.
// ---------------------------------------------------------------------------

export interface RenderGraphLiveOptions {
  readonly setExitCode?: (code: number) => void;
}

/**
 * Render the live `graph` view. Returns once the underlying Ink app exits.
 *
 * The graph tool's `register(cli)` wires this through
 * `cli.registerLiveView('graph', (args) => renderGraphLive(args, { ... }))`.
 * `setExitCode` is the single mutator path on `process.exitCode`; the
 * runner calls it for error outcomes so the CLI's exit-code seam stays
 * the only writer.
 */
export async function renderGraphLive(
  args: GraphRunnerArgs,
  datastore?: DataStore,
  options?: RenderGraphLiveOptions,
): Promise<void> {
  const app = render(
    <GraphRunner args={args} datastore={datastore} setExitCode={options?.setExitCode} />,
  );
  await app.waitUntilExit();
  process.stdout.write('\n');
}
