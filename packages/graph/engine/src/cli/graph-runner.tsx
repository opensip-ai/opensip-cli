/**
 * graph-runner — owns the live-view state machine for `opensip-tools graph`.
 *
 * Layer 5 Phase 3 lifted the graph live view out of `opensip-tools`.
 * The state machine (loading → running → done | error), `runGraph`
 * orchestration, `buildUnifiedReportLines` post-call, and the Ink/React
 * render tree live here, in the package that owns the graph command
 * surface. Adding a fourth tool with a live view requires zero CLI
 * edits — each tool ships its own renderer and registers it via
 * `cli.registerLiveView(key, renderer)`.
 *
 * Progress rendering is the shared `<LiveProgress>` from
 * `@opensip-tools/cli-ui` (ADR-0015), driven in `phases` mode: graph's
 * 7 fixed pipeline stages map onto the universal `ProgressEvent` stream.
 * The former graph-local StageChecklist/StageLine/RunningStageLine are
 * gone. The transport is the in-process one here — graph's pipeline is a
 * synchronous CPU blast, so the spinner does not yet animate (the
 * subprocess transport that frees the render thread lands in a later
 * phase); this phase unifies the visual without changing that behavior.
 *
 * Single exit-code write path: error outcomes route through the
 * supplied `setExitCode` callback (`ToolCliContext.setExitCode`) so the
 * CLI keeps its only `process.exitCode` mutator.
 */

import {
  Banner,
  ClockProvider,
  ErrorMessage,
  LiveProgress,
  normalizeBannerSize,
  ProjectHeader,
  RunFooterHints,
  RunHeader,
  RunSummary,
  ThemeProvider,
  UpdateHint,
  type ProgressCallback,
  type ProgressEvent,
  type ProgressSurface,
} from '@opensip-tools/cli-ui';
import { createInProcessTransport, currentScope } from '@opensip-tools/core';
import { Box, Text, useApp, render } from 'ink';
import React, { useEffect, useState } from 'react';

import { buildGraphEnvelope } from './build-envelope.js';
import { buildUnifiedReportLines, persistSession } from './graph.js';
import { GRAPH_STAGES, runGraph } from './orchestrate.js';

import type { GraphProgressEvent, GraphStage, RunGraphResult } from './orchestrate.js';
import type { GraphConfig, ResolutionMode, Rule } from '../types.js';
import type { DataStore } from '@opensip-tools/datastore';

const GRAPH_TOOL_TITLE = 'Code Graph';
const GRAPH_TOOL_DESCRIPTION = 'Building call-graph from source';

const STAGE_LABELS: Readonly<Record<GraphStage, string>> = {
  discover: 'Discover files',
  parse: 'Parse project',
  walk: 'Walk catalog',
  resolve: 'Resolve call sites',
  index: 'Build indexes',
  features: 'Derive features',
  rules: 'Evaluate rules',
};

const STAGE_RUNNING_DETAIL: Readonly<Record<GraphStage, string>> = {
  discover: 'Scanning source tree...',
  parse: 'Building program AST...',
  walk: 'Walking files for occurrences...',
  resolve: 'Binding symbols to edges...',
  index: 'Computing reverse indexes...',
  features: 'Computing feature columns...',
  rules: 'Evaluating rule set...',
};

// The phases surface the shared renderer consumes: graph's fixed, ordered
// stages, each carrying its checklist label + running sub-label.
const GRAPH_SURFACE: ProgressSurface = {
  shape: 'phases',
  stages: GRAPH_STAGES.map((id) => ({
    id,
    label: STAGE_LABELS[id],
    runningDetail: STAGE_RUNNING_DETAIL[id],
  })),
};

/** Map graph's pipeline event onto the universal progress currency. */
function toProgressEvent(event: GraphProgressEvent): ProgressEvent {
  if (event.type === 'stage-start') {
    return { type: 'stage-start', stage: event.stage, label: STAGE_LABELS[event.stage] };
  }
  if (event.type === 'stage-done') {
    return { type: 'stage-done', stage: event.stage, durationMs: event.durationMs ?? 0, detail: event.detail };
  }
  return { type: 'stage-cached', stage: event.stage };
}

interface RunSummaryShape {
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
  readonly warnings: number;
  readonly durationMs: number;
}

type ViewState =
  | { phase: 'loading' }
  | { phase: 'running'; subscribe: (cb: ProgressCallback) => void }
  | { phase: 'done'; subscribe: (cb: ProgressCallback) => void; reportLines: readonly string[]; summary: RunSummaryShape }
  | { phase: 'error'; message: string };

interface GraphRunnerArgs {
  readonly cwd: string;
  readonly noCache?: boolean;
  /**
   * `--resolution`: edge resolution tier. Forwarded to `runGraph` so the
   * interactive default path (`graph --resolution fast` with no other
   * flags) actually runs the chosen tier instead of silently using exact.
   */
  readonly resolution?: ResolutionMode;
  /**
   * `--verbose`: when true, show the detailed catalog / findings-by-rule
   * / entry-points blocks in the done view. Default (false) shows the
   * summary line + footer hint only, matching fit's default surface.
   */
  readonly verbose?: boolean;
  /**
   * The project's `graph:` config block (rule knobs like
   * `minCrossPackageDuplicatePackages`, `minDuplicateBodyLines`,
   * `entryPointHashes`). Forwarded to `runGraph` so the interactive
   * default path honors the SAME config as the `executeGraph` dispatch
   * path.
   */
  readonly config?: GraphConfig;
  /**
   * `--recipe`: the resolved rule subset for this run. Resolved on the
   * dispatch seam (`tool.ts`, inside the entered RunScope) and forwarded
   * to `runGraph` so the interactive path honors `--recipe` for parity
   * with `executeGraph`. Absent ⇒ `runGraph` falls back to `currentRules()`.
   */
  readonly rules?: readonly Rule[];
}

/** Run the pipeline through the transport, mapping graph events to the shared
 *  progress currency. Hoisted to module scope so the emit translation isn't a
 *  deeply-nested function inside the runner's effect. */
function runGraphWithProgress(
  args: GraphRunnerArgs,
  datastore: DataStore | undefined,
  emit: (event: ProgressEvent) => void,
): Promise<RunGraphResult> {
  return runGraph({
    cwd: args.cwd,
    noCache: args.noCache,
    resolution: args.resolution,
    config: args.config,
    rules: args.rules,
    datastore,
    onProgress: (event) => emit(toProgressEvent(event)),
  });
}

interface GraphRunnerProps {
  readonly args: GraphRunnerArgs;
  readonly datastore?: DataStore;
  readonly setExitCode?: (code: number) => void;
}

function GraphRunner({ args, datastore, setExitCode }: GraphRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<ViewState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    const transport = createInProcessTransport();
    const run = transport.run<ProgressEvent, RunGraphResult>(
      (emit) => runGraphWithProgress(args, datastore, emit),
    );
    setState({ phase: 'running', subscribe: run.onProgress });

    void (async () => {
      try {
        const result = await run.result;
        if (cancelled) return;
        const durationMs = Date.now() - startedAt;
        // Persist exactly one session — matches the contract the dispatch-path
        // orchestrator (`executeGraph` → `persistSession`) enforces, so the
        // dashboard's Code Paths > Sessions sees the interactive run.
        persistSession({ cwd: args.cwd }, result.signals, datastore, durationMs);
        // Compute the fit-style summary the cli-ui `RunSummary` renders. The
        // envelope's verdict applies the fit-aligned per-rule pass rule.
        const verdictSummary = buildGraphEnvelope({
          signals: result.signals,
          runId: currentScope()?.runId ?? '',
          createdAt: new Date().toISOString(),
        }).verdict.summary;
        const summary: RunSummaryShape = {
          passed: verdictSummary.passed,
          failed: verdictSummary.failed,
          errors: verdictSummary.errors,
          warnings: verdictSummary.warnings,
          durationMs,
        };
        // includeSummary: false — RunSummary takes the place of the text
        // "== Summary ==" footer buildUnifiedReportLines used to append.
        const reportLines = buildUnifiedReportLines({
          catalog: result.catalog,
          indexes: result.indexes,
          signals: result.signals,
          cacheHit: result.cacheHit,
        }, { includeSummary: false });
        setState((prev) => ({
          phase: 'done',
          subscribe: prev.phase === 'running' ? prev.subscribe : run.onProgress,
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

  // Presentation settings resolved once in the pre-action hook; the live view
  // runs inside that scope. `mini` carries the project path in its box, so the
  // separate ProjectHeader line is dropped for it (matches App.tsx); walkedUp
  // flows in so mini keeps the "(found N levels up)" hint.
  const scope = currentScope();
  const ui = scope?.ui;
  const walkedUp = scope?.projectContext?.walkedUp;
  const bannerSize = normalizeBannerSize(ui?.bannerSize);
  const header = (
    <>
      <Banner size={bannerSize} version={ui?.version} projectPath={args.cwd} walkedUp={walkedUp} update={ui?.update} />
      {bannerSize === 'mini' && ui?.update !== undefined && <UpdateHint />}
      {bannerSize !== 'mini' && <ProjectHeader root={args.cwd} walkedUp={walkedUp} />}
      <RunHeader tool={GRAPH_TOOL_TITLE} description={GRAPH_TOOL_DESCRIPTION} />
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

  // running | done — the same <LiveProgress> stays mounted across both so its
  // reduced stage state (the ✓ checklist) persists; the done phase adds the
  // summary + footer below it.
  return (
    <Box flexDirection="column">
      {header}
      <LiveProgress surface={GRAPH_SURFACE} subscribe={state.subscribe} />
      {state.phase === 'done' && (
        <>
          {args.verbose === true && (
            <Box flexDirection="column" paddingTop={1}>
              {state.reportLines.map((line, i) => (
                <Text key={i}>{line}</Text>
              ))}
            </Box>
          )}
          <RunSummary
            passed={state.summary.passed}
            failed={state.summary.failed}
            errors={state.summary.errors}
            warnings={state.summary.warnings}
            durationMs={state.summary.durationMs}
          />
          {args.verbose !== true && (
            <RunFooterHints
              hints={[
                { text: 'Use --verbose for detailed results', bold: ['--verbose'] },
                { text: 'opensip-tools dashboard for HTML report', bold: ['opensip-tools dashboard'] },
                { text: '--report-to <url> to send to OpenSIP', bold: ['--report-to <url>'] },
              ]}
            />
          )}
        </>
      )}
    </Box>
  );
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
