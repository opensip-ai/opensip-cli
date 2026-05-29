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
 * Shared presentational primitives (Banner, RunHeader, theme tokens)
 * come from `@opensip-tools/cli-ui`. The stage-checklist component is
 * graph-specific and stays here.
 *
 * Single exit-code write path: error outcomes route through the
 * supplied `setExitCode` callback (`ToolCliContext.setExitCode`) so the
 * CLI keeps its only `process.exitCode` mutator. The historical
 * `process.exitCode = 1` write that lived in GraphView is gone.
 */

import {
  Banner,
  ClockProvider,
  ErrorMessage,
  RunFooterHints,
  RunHeader,
  RunSummary,
  ThemeProvider,
  useSpinner,
  useTheme,
} from '@opensip-tools/cli-ui';
import { Box, Text, useApp, render } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

import { buildCliOutput } from '../render/json.js';

import { buildUnifiedReportLines, persistSession } from './graph.js';
import { GRAPH_STAGES, runGraph } from './orchestrate.js';

import type { GraphProgressEvent, GraphStage, RunGraphResult } from './orchestrate.js';
import type { DataStore } from '@opensip-tools/datastore';

const GRAPH_TOOL_TITLE = 'Code Graph';
const GRAPH_TOOL_DESCRIPTION = 'Building call-graph from source';

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

interface RunSummaryShape {
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly warnings: number;
  readonly durationMs: number;
}

type ViewState =
  | { phase: 'loading' }
  | { phase: 'running'; stages: StageMap }
  | { phase: 'done'; stages: StageMap; reportLines: readonly string[]; summary: RunSummaryShape }
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
    const startedAt = Date.now();
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
        const durationMs = Date.now() - startedAt;
        // Persist exactly one session — matches the contract the
        // dispatch-path orchestrator (`executeGraph` → `persistSession`)
        // enforces. Without this call, default `opensip-tools graph`
        // (no args, no flags) runs the live view but writes no row,
        // so the dashboard's Code Paths > Sessions never sees the run.
        persistSession({ cwd: args.cwd }, result.signals, datastore);
        // Compute the fit-style summary the cli-ui `RunSummary` renders.
        // buildCliOutput already applies the fit-aligned per-rule pass
        // rule (`errors === 0` per render/json.ts), so the passed/failed
        // counts here match what fit shows for an equivalent run.
        const cliOutput = buildCliOutput(result.signals, 'graph');
        const summary: RunSummaryShape = {
          passed: cliOutput.summary.passed,
          failed: cliOutput.summary.failed,
          errors: cliOutput.summary.errors,
          warnings: cliOutput.summary.warnings,
          durationMs,
        };
        // includeSummary: false — RunSummary takes the place of the
        // text "== Summary ==" footer that buildUnifiedReportLines used
        // to append.
        const reportLines = buildUnifiedReportLines({
          catalog: result.catalog,
          indexes: result.indexes,
          signals: result.signals,
          cacheHit: result.cacheHit,
        }, { includeSummary: false });
        setState((prev) => ({
          phase: 'done',
          stages: prev.phase === 'running' ? prev.stages : initialStages(),
          reportLines,
          summary,
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
      <RunHeader tool={GRAPH_TOOL_TITLE} description={GRAPH_TOOL_DESCRIPTION} projectRoot={args.cwd} />
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
        <>
          <Box flexDirection="column" paddingTop={1}>
            {state.reportLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
          <RunSummary
            passed={state.summary.passed}
            failed={state.summary.failed}
            errors={state.summary.errors}
            warnings={state.summary.warnings}
            durationMs={state.summary.durationMs}
          />
          <RunFooterHints
            hints={[
              { text: 'opensip-tools dashboard for HTML report', bold: ['opensip-tools dashboard'] },
              { text: '--json for structured output', bold: ['--json'] },
              { text: '--workspace to fan out across packages', bold: ['--workspace'] },
            ]}
          />
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Stage-checklist — graph-specific visual. Banner/RunHeader/ErrorMessage
// come from @opensip-tools/cli-ui (imported at the top).
// ---------------------------------------------------------------------------

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
  // Re-render on each tick; derive wall-clock elapsed from Date.now() so it
  // stays accurate regardless of how many ticks have fired since startedAt.
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
    <ThemeProvider>
      <ClockProvider>
        <GraphRunner args={args} datastore={datastore} setExitCode={options?.setExitCode} />
      </ClockProvider>
    </ThemeProvider>,
  );
  await app.waitUntilExit();
  process.stdout.write('\n');
}
