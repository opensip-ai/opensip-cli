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
 * `@opensip-tools/cli-ui` (ADR-0016), driven in `phases` mode: graph's
 * 7 fixed pipeline stages map onto the universal `ProgressEvent` stream.
 * The former graph-local StageChecklist/StageLine/RunningStageLine are
 * gone. The build runs OFF the main process (ADR-0028): the runner forks
 * the CLI to `graph-run-worker` via `runOffThreadOrInProcess`, which
 * re-bootstraps the scope, runs the heavy build, and streams stage progress
 * + the slim {@link LiveGraphOutput} back over IPC — so this process stays
 * free to animate the spinner + 80ms clock instead of freezing under the
 * type-check. It falls back to the in-process closure when forking is
 * disabled (`OPENSIP_TOOLS_NO_WORKER`) or the fork fails; both paths reduce
 * to the same `{ signals, reportLines }` payload.
 *
 * Single exit-code write path: error outcomes route through the
 * supplied `setExitCode` callback (`ToolCliContext.setExitCode`) so the
 * CLI keeps its only `process.exitCode` mutator.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Banner,
  ClockProvider,
  ErrorMessage,
  LiveProgress,
  normalizeBannerSize,
  ProjectHeader,
  renderToInk,
  RunFooterHints,
  RunHeader,
  RunSummary,
  ThemeProvider,
  UpdateHint,
  VERBOSE_DETAIL_HINT,
  viewVerboseLines,
  type ProgressCallback,
  type ProgressEvent,
  type ProgressSurface,
} from '@opensip-tools/cli-ui';
import { runOffThreadOrInProcess, currentScope } from '@opensip-tools/core';
import { Box, Text, useApp, render } from 'ink';
import React, { useEffect, useState } from 'react';

import { assertFinalizedAcrossBoundary } from './apply-suppressions.js';
import { buildGraphEnvelope } from './build-envelope.js';
import { SHARDED_STAGE_LABELS, STAGE_LABELS, toProgressEvent } from './graph-progress.js';
import {
  buildLiveGraphOutput,
  persistSession,
  runShardedLiveBuild,
  type LiveGraphOutput,
} from './graph.js';
import { GRAPH_STAGES, runGraph } from './orchestrate.js';

import type { Shard } from './orchestrate/shard-model.js';
import type { GraphStage } from './orchestrate.js';
import type { GraphConfig, ResolutionMode, Rule } from '../types.js';
import type { DataStore } from '@opensip-tools/datastore';

const GRAPH_TOOL_TITLE = 'Code Graph';
const GRAPH_TOOL_DESCRIPTION = 'Building call-graph from source';

const STAGE_RUNNING_DETAIL: Readonly<Record<GraphStage, string>> = {
  discover: 'Scanning source tree...',
  parse: 'Building program AST...',
  walk: 'Walking files for occurrences...',
  resolve: 'Binding symbols to edges...',
  index: 'Computing reverse indexes...',
  features: 'Computing feature columns...',
  rules: 'Evaluating rule set...',
};

// Sharded-engine running sub-labels — mirror SHARDED_STAGE_LABELS: the parallel
// shard build (parse), the fragment merge (walk), the cross-package link (resolve).
const SHARDED_STAGE_RUNNING_DETAIL: Readonly<Record<GraphStage, string>> = {
  ...STAGE_RUNNING_DETAIL,
  parse: 'Building shards in parallel...',
  walk: 'Merging shard fragments...',
  resolve: 'Linking cross-package calls...',
};

// The phases surface the shared renderer consumes: graph's fixed, ordered stages,
// each carrying its checklist label + running sub-label. Engine-aware: the sharded
// pipeline names its stages for what they actually do (Build shards / Merge catalog
// / Link cross-package) so the checklist reflects the real parallel build, not the
// single-program "Parse / Walk / Resolve" shape.
function graphSurface(sharded: boolean): ProgressSurface {
  const labels = sharded ? SHARDED_STAGE_LABELS : STAGE_LABELS;
  const runningDetail = sharded ? SHARDED_STAGE_RUNNING_DETAIL : STAGE_RUNNING_DETAIL;
  return {
    shape: 'phases',
    stages: GRAPH_STAGES.map((id) => ({
      id,
      label: labels[id],
      runningDetail: runningDetail[id],
    })),
  };
}

interface RunSummaryShape {
  /** ADR-0035: the run's single verdict — the headline PASS/FAIL token. */
  readonly passed: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly durationMs: number;
}

type ViewState =
  | { phase: 'loading' }
  | { phase: 'running'; subscribe: (cb: ProgressCallback) => void }
  | {
      phase: 'done';
      subscribe: (cb: ProgressCallback) => void;
      reportLines: readonly string[];
      summary: RunSummaryShape;
    }
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
  /** `--quiet`: suppress the banner / project header / run header chrome, leaving
   *  only the live progress, summary, and (when not verbose) footer hints —
   *  parity with fit/sim. */
  readonly quiet?: boolean;
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
  /**
   * `--recipe` NAME (serializable), forwarded to the off-process worker so it can
   * re-resolve the rule set itself (rules are functions — they can't cross the
   * fork boundary). The in-process fallback uses {@link GraphRunnerArgs.rules}.
   */
  readonly recipe?: string;
  /**
   * `--exact`: whether the user opted out of the default sharded engine. Threaded
   * through so the live view drives the SAME engine the static path's policy
   * selects (ADR-0032). `isTTY` NEVER affects the engine — only `exact` +
   * shardability do.
   */
  readonly exact?: boolean;
  /**
   * The pre-resolved shard set (ADR-0032), computed on the dispatch seam
   * (`dispatchGraphLiveView`, which holds the `cli` context the engine policy
   * needs). `length > 1` ⇒ the SHARDED engine runs IN-PROCESS here (its shards
   * are already subprocesses, so the render thread isn't doing the heavy build);
   * otherwise the EXACT single-program engine runs OFF-process in the
   * `graph-run-worker` (ADR-0028). Passed by reference in-process (the runner
   * shares the dispatch process), so the file paths never cross an IPC boundary.
   */
  readonly shards?: readonly Shard[];
}

/** Run the pipeline through the in-process transport, mapping graph events to the
 *  shared progress currency and reducing the result to the slim, serializable
 *  {@link LiveGraphOutput} the done handler consumes — IDENTICAL to what the
 *  off-process worker streams back, so both paths converge on one payload shape.
 *  Hoisted to module scope so the emit translation isn't a deeply-nested function
 *  inside the runner's effect. */
async function runGraphWithProgress(
  args: GraphRunnerArgs,
  datastore: DataStore | undefined,
  emit: (event: ProgressEvent) => void,
): Promise<LiveGraphOutput> {
  const result = await runGraph({
    cwd: args.cwd,
    noCache: args.noCache,
    resolution: args.resolution,
    config: args.config,
    rules: args.rules,
    datastore,
    onProgress: (event) => emit(toProgressEvent(event)),
  });
  // The interactive live view is whole-project against cwd, so cwd is the build
  // root the signals' code.file paths resolve against — pass it as the
  // suppression base so the in-process leg waives `@graph-ignore` identically to
  // the static path (and to the off-process worker, which uses args.cwd too).
  return buildLiveGraphOutput(result, args.cwd);
}

interface GraphRunnerProps {
  readonly args: GraphRunnerArgs;
  readonly datastore?: DataStore;
  readonly setExitCode?: (code: number) => void;
}

function GraphRunner({ args, datastore, setExitCode }: GraphRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<ViewState>({ phase: 'loading' });
  // Engine policy (ADR-0032): sharded is the default, `--exact` opts out. The
  // engine is selected upstream and handed to us as `args.shards` (length > 1 ⇒
  // sharded). Drives BOTH the run transport (in-process vs off-process worker)
  // and the engine-aware checklist labels below. `isTTY` never affects it.
  const sharded = (args.shards?.length ?? 0) > 1;

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    // Engine policy (ADR-0032): the SHARDED engine is the default; `--exact`
    // opts out. The engine is selected upstream on the dispatch seam (which holds
    // the `cli` context) and handed to us as `args.shards` — `length > 1` ⇒
    // sharded. `isTTY` NEVER affects this decision; we are only choosing the
    // RENDERER's transport here, not the engine.
    //
    //   - SHARDED (default): run IN-PROCESS. Its shards are already subprocesses,
    //     so the heavy parse/walk/resolve is off the render thread and the main
    //     thread stays free to animate the checklist + 80ms clock while it awaits
    //     the (I/O-bound) shard pool. No `graph-run-worker` fork needed.
    //   - EXACT (`--exact` / not-shardable fallback): run the single-program build
    //     OFF the main process (ADR-0028) — fork the CLI to `graph-run-worker`,
    //     which streams stage progress + the slim LiveGraphOutput over IPC, so the
    //     heavy in-process type-check never freezes the spinner. Falls back to the
    //     in-process closure (OPENSIP_TOOLS_NO_WORKER / fork failure), which
    //     reduces to the SAME LiveGraphOutput.
    //
    // Both transports converge on one `LiveGraphOutput` — already crossed the
    // single suppression chokepoint (`buildLiveGraphOutput` → `finalizeGraphSignals`).
    const specDir = mkdtempSync(join(tmpdir(), 'graph-worker-'));
    const specPath = join(specDir, 'spec.json');
    writeFileSync(
      specPath,
      JSON.stringify({
        cwd: args.cwd,
        noCache: args.noCache,
        resolution: args.resolution,
        ...(args.recipe === undefined ? {} : { recipe: args.recipe }),
      }),
      'utf8',
    );
    const run = runOffThreadOrInProcess<ProgressEvent, LiveGraphOutput>({
      // Sharded runs in-process (shards are already subprocesses); exact forks the
      // off-process worker. `preferWorker:false` forces the in-process arm for the
      // sharded path — the descriptor is unused there but still required by the API.
      preferWorker: !sharded,
      descriptor: { command: process.argv[1] ?? '', argv: ['graph-run-worker', specPath] },
      inProcess: (emit) =>
        sharded
          ? runShardedLiveBuild(
              {
                cwd: args.cwd,
                noCache: args.noCache,
                resolution: args.resolution,
                exact: args.exact,
                config: args.config,
                rules: args.rules,
                cliScript: process.argv[1],
              },
              args.shards ?? [],
              datastore,
              (event) => emit(toProgressEvent(event, true)),
            )
          : runGraphWithProgress(args, datastore, emit),
    });
    setState({ phase: 'running', subscribe: run.onProgress });

    void (async () => {
      try {
        let result: LiveGraphOutput;
        try {
          result = await run.result;
        } finally {
          rmSync(specDir, { recursive: true, force: true });
        }
        if (cancelled) return;
        const durationMs = Date.now() - startedAt;
        // `result` already crossed the single suppression chokepoint inside the
        // producer (`buildLiveGraphOutput` → `finalizeGraphSignals`), but the
        // IPC structured-clone dropped the FinalizedSignals brand. Re-stamp it
        // here — an assertion of the prior finalize, NOT a second suppression —
        // so persistSession (and the verdict below, derived from the same set)
        // consume the branded, already-waived signals. This is the live path's
        // structural parity with the static `dispatchGraphResult` path.
        const finalized = assertFinalizedAcrossBoundary(result.signals, result.suppressedCount);
        // Persist exactly one session — matches the contract the dispatch-path
        // orchestrator (`executeGraph` → `persistSession`) enforces, so the
        // dashboard's Code Paths > Sessions sees the interactive run.
        persistSession({ cwd: args.cwd }, finalized, datastore, durationMs);
        // Compute the fit-style summary the cli-ui `RunSummary` renders from the
        // SAME waived set — so the TTY summary matches the piped report.
        const verdict = buildGraphEnvelope({
          signals: finalized.signals,
          runId: currentScope()?.runId ?? '',
          createdAt: new Date().toISOString(),
        }).verdict;
        const summary: RunSummaryShape = {
          passed: verdict.passed,
          errors: verdict.summary.errors,
          warnings: verdict.summary.warnings,
          durationMs,
        };
        // The worker (or the in-process fallback) already assembled the report
        // lines with includeSummary: false — RunSummary renders the verdict
        // footer in place of the text "== Summary ==" block.
        const reportLines = result.reportLines;
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
    return () => {
      cancelled = true;
    };
  }, []);

  // Presentation settings resolved once in the pre-action hook; the live view
  // runs inside that scope. `mini` carries the project path in its box, so the
  // separate ProjectHeader line is dropped for it (matches App.tsx); walkedUp
  // flows in so mini keeps the "(found N levels up)" hint.
  const scope = currentScope();
  const ui = scope?.ui;
  const walkedUp = scope?.projectContext?.walkedUp;
  const bannerSize = normalizeBannerSize(ui?.bannerSize);
  // --quiet suppresses the banner/header chrome (parity with fit/sim).
  const header =
    args.quiet === true ? null : (
      <>
        <Banner
          size={bannerSize}
          version={ui?.version}
          projectPath={args.cwd}
          walkedUp={walkedUp}
          update={ui?.update}
        />
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
      <LiveProgress surface={graphSurface(sharded)} subscribe={state.subscribe} />
      {state.phase === 'done' && (
        <>
          {args.verbose === true && (
            <Box flexDirection="column" paddingTop={1}>
              {renderToInk(viewVerboseLines(state.reportLines))}
            </Box>
          )}
          <RunSummary
            passed={state.summary.passed}
            errors={state.summary.errors}
            warnings={state.summary.warnings}
            durationMs={state.summary.durationMs}
          />
          {args.verbose !== true && (
            <RunFooterHints
              hints={[
                VERBOSE_DETAIL_HINT,
                {
                  text: 'opensip-tools dashboard for HTML report',
                  bold: ['opensip-tools dashboard'],
                },
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
 * The graph tool wires this in via `setUpGraphLiveView`, which calls
 * `cli.registerLiveView('graph', (args) => renderGraphLive(args, { ... }))`
 * lazily on the interactive path (there is no `register()` mount hook).
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
