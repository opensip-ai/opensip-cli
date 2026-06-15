/**
 * fit-runner — owns the live-view state machine for `opensip fit`.
 *
 * Layer 5 Phase 3 lifted the fit live view out of `opensip-cli`.
 * The state machine (loading → running → done | error), `executeFit`
 * orchestration, `reportToCloud` post-call, and the Ink/React render
 * tree all live here, in the package that owns the fitness command
 * surface. Adding a fourth tool with a live view requires zero CLI
 * edits — each tool ships its own renderer and registers it via
 * `cli.registerLiveView(key, renderer)`.
 *
 * Shared presentational primitives (Banner, RunHeader, Spinner, theme
 * tokens) come from `@opensip-cli/cli-ui`. Tool-specific render
 * pieces (results table, findings block, cloud-report status) live in
 * `cli/fit-runner-views.tsx`; they're imported here so this module
 * stays focused on the state machine and entry point.
 *
 * Single exit-code write path: error-result conditions route through the
 * supplied `setExitCode` callback (`ToolCliContext.setExitCode`) so the CLI keeps
 * its single `process.exitCode` mutator. The findings exit is host-owned
 * (ADR-0035: derived from the envelope verdict in `deliverSignals`). The
 * historical `process.exitCode = N` writes that lived in FitView are
 * gone.
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
  RunTimingProvider,
  ThemeProvider,
  UpdateHint,
  VERBOSE_DETAIL_HINT,
  viewFindingsGroups,
  type ProgressCallback,
  type ProgressEvent,
  type ProgressSurface,
} from '@opensip-cli/cli-ui';
import {
  type FitOptions,
  type ErrorResult,
  type FitDoneResult,
  type SignalEnvelope,
} from '@opensip-cli/contracts';
import {
  runOffThreadOrInProcess,
  currentScope,
  type LiveViewContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { Box, Static, Text, useApp, render } from 'ink';
import React, { useEffect, useState } from 'react';

import { envelopeToFitRows } from './fit/envelope-view.js';
import { buildFitnessSessionPayload } from './fit/result-builders.js';
import { ResultsTable, WarningsBlock } from './fit-runner-views.js';
import { ensureChecksLoaded, executeFit, getEnabledCheckCount } from './fit.js';

import type { DataStore } from '@opensip-cli/datastore';

// Theme constants used by tool-specific sub-components below. The shared
// presentational primitives (Banner, RunHeader, Spinner, ErrorMessage)
// pull their colors from cli-ui's ThemeProvider; the tool-specific
// renderers also use useTheme() to stay consistent.
const FIT_TOOL_TITLE = 'Fitness Checks';
const FIT_TOOL_DESCRIPTION =
  'Scanning your codebase for quality, security, and architecture issues.';

// Pool-shape surfaces for the shared <LiveProgress> renderer. fit's checks are a
// dynamic pool (many, counted), not a fixed pipeline — so it renders as one
// spinner + completed/total counter. The synthetic stage id is 'checks'.
const FIT_LOADING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Loading checks...' };
const FIT_RUNNING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Running checks...' };
const NO_PROGRESS: (cb: ProgressCallback) => void = () => {
  // The loading phase has no live event stream yet — LiveProgress renders a bare
  // animated spinner from a no-op subscription.
};

/**
 * Run fit, translating the engine's monotonic (completed, total) callback into
 * pool-shape ProgressEvents on the `'checks'` stage. Hoisted to module scope so
 * the emit translation isn't a 5th-level nested function inside the runner's
 * effect.
 */
function executeFitWithProgress(
  args: FitOptions,
  emit: (event: ProgressEvent) => void,
): ReturnType<typeof executeFit> {
  emit({ type: 'stage-start', stage: 'checks', label: 'Running checks...' });
  return executeFit(args, {
    onProgress: (completed, total) =>
      emit({ type: 'stage-progress', stage: 'checks', completed, total }),
  });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type FitState =
  | { phase: 'loading' }
  | { phase: 'running'; checkCount: number; subscribe: (cb: ProgressCallback) => void }
  // durationMs dropped (host-owned run timing); the RunTimingProvider + RunSummary
  // (or internal clock for live progress) supply timing. Keep only internal recipe
  // makespan if the component needs it for non-summary UI.
  | { phase: 'done'; result: FitDoneResult; checkCount: number }
  | { phase: 'error'; result: ErrorResult };

interface FitRunnerProps {
  readonly args: FitOptions;
  readonly setExitCode?: (code: number) => void;
  /** Called with the run's envelope once it completes, for root-owned egress. */
  readonly onEnvelope?: (envelope: SignalEnvelope) => void;
  /**
   * Called with the run's generic-session contribution once it completes
   * (host-owned-run-timing Phase 2). The host persists it after the live view
   * exits — the component must NOT write the session itself.
   */
  readonly onSession?: (contribution: ToolSessionContribution) => void;
  /** LiveViewContext from host — carries the run timer for the RunTimingProvider. */
  readonly liveContext?: LiveViewContext;
}

function FitRunner({
  args,
  setExitCode,
  onEnvelope,
  onSession,
  liveContext,
}: FitRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<FitState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Phase 1: Load checks to get count for header
      await ensureChecksLoaded(args.cwd);
      const checkCount = getEnabledCheckCount();

      if (cancelled) return;

      // Execute OFF the main process (ADR-0028): fork the CLI to `fit-run-worker`,
      // which re-bootstraps the full scope and streams progress + the final result
      // over IPC, so this process stays free to animate the spinner + 80ms clock.
      // `runOffThreadOrInProcess` falls back to the in-process closure when forking
      // is disabled/unavailable (OPENSIP_CLI_NO_WORKER) — identical result either
      // way. The worker reads its run spec (the serializable FitOptions) from a
      // temp file we clean up after the run settles.
      const specDir = mkdtempSync(join(tmpdir(), 'fit-worker-'));
      const specPath = join(specDir, 'spec.json');
      writeFileSync(specPath, JSON.stringify(args), 'utf8');
      const run = runOffThreadOrInProcess<ProgressEvent, Awaited<ReturnType<typeof executeFit>>>({
        descriptor: { command: process.argv[1] ?? '', argv: ['fit-run-worker', specPath] },
        inProcess: (emit) => executeFitWithProgress(args, emit),
      });

      setState({ phase: 'running', checkCount, subscribe: run.onProgress });

      let fitResult: Awaited<ReturnType<typeof executeFit>>;
      try {
        fitResult = await run.result;
      } finally {
        rmSync(specDir, { recursive: true, force: true });
      }

      if (cancelled) return;

      if (fitResult.result.type === 'error') {
        setState({ phase: 'error', result: fitResult.result });
        setExitCode?.(fitResult.result.exitCode);
        setTimeout(() => exit(), 100);
        return;
      }

      const { result } = fitResult as { result: FitDoneResult };

      // ADR-0035: the host owns the findings exit. The live renderer returns the
      // envelope to `setUpFitLiveView`, which calls `deliverSignals`; the root
      // sets the exit from `envelope.verdict.passed` there. No setExitCode here.

      // Host-owned persistence (host-owned-run-timing Phase 2): the component no
      // longer writes the session. It surfaces the contribution; the host
      // completes the lifecycle and persists after `renderLive` resolves.
      if (result.envelope) {
        onSession?.({
          tool: 'fit',
          cwd: args.cwd,
          recipe: result.envelope.recipe,
          score: result.envelope.verdict.score,
          passed: result.envelope.verdict.passed,
          payload: buildFitnessSessionPayload(result.envelope),
        });
      }

      // Effectful egress (cloud + `--report-to`) lives at the composition root
      // now (ADR-0011): `renderFitLive` returns this envelope and the tool's
      // `registerLiveView` callback delivers it once the Ink app exits.
      onEnvelope?.(result.envelope);

      setState({ phase: 'done', result, checkCount });
      setTimeout(() => exit(), 100);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const recipe =
    args.tags && args.tags.length > 0 ? `tags: ${args.tags.join(',')}` : (args.recipe ?? 'default');

  // Banner + RunHeader both live in <Static> so Ink writes them once above the
  // dynamic redraw region and never touches those bytes again. The dynamic
  // region contains ONLY the things that actually change between frames
  // (spinner during loading/running; summary block during done) — small,
  // stable-width content that Ink can redraw without its line-clear heuristic
  // miscounting and producing overdraw.
  //
  // Static is incremental: items added in later renders are appended below
  // existing static content. We start with just the banner (we don't know
  // checkCount yet during loading), and append the header once checkCount is
  // known. RunHeader's metadata only changes once (when loading→running), and
  // after that it's stable for the rest of the run — perfect Static fit.
  const checkCount = state.phase === 'running' || state.phase === 'done' ? state.checkCount : null;
  const staticItems = computeStaticItems(args.quiet === true, checkCount);

  // Presentation settings resolved once in the pre-action hook. The live
  // view runs inside that scope, so it reads the same banner size + version
  // the static path does. `mini` carries the project path in its box, so we
  // drop the separate ProjectHeader line for it (matches App.tsx) and pass
  // the scope's walkedUp so mini keeps the "(found N levels up)" hint.
  const scope = currentScope();
  const ui = scope?.ui;
  const walkedUp = scope?.projectContext?.walkedUp;
  const bannerSize = normalizeBannerSize(ui?.bannerSize);
  const showProjectHeader = bannerSize !== 'mini';

  const renderStaticItem = (item: 'banner' | 'header'): React.ReactElement => {
    if (item === 'banner') {
      return (
        <React.Fragment key={item}>
          <Banner
            size={bannerSize}
            version={ui?.version}
            projectPath={args.cwd}
            walkedUp={walkedUp}
            update={ui?.update}
          />
          {bannerSize === 'mini' && ui?.update !== undefined && <UpdateHint />}
          {showProjectHeader && <ProjectHeader root={args.cwd} walkedUp={walkedUp} />}
        </React.Fragment>
      );
    }
    const metadata = [
      { label: 'Recipe', value: recipe },
      { label: 'Checks', value: String(checkCount) },
    ];
    return (
      <RunHeader
        key={item}
        tool={FIT_TOOL_TITLE}
        description={FIT_TOOL_DESCRIPTION}
        metadata={metadata}
      />
    );
  };

  const staticHeader = <Static items={staticItems}>{renderStaticItem}</Static>;

  switch (state.phase) {
    case 'loading': {
      return (
        <>
          {staticHeader}
          <Box paddingTop={1}>
            <LiveProgress surface={FIT_LOADING_SURFACE} subscribe={NO_PROGRESS} />
          </Box>
        </>
      );
    }

    case 'running': {
      return (
        <>
          {staticHeader}
          <LiveProgress surface={FIT_RUNNING_SURFACE} subscribe={state.subscribe} />
        </>
      );
    }

    case 'done': {
      const { envelope, verboseDetail } = state.result;
      const { summary } = envelope.verdict;
      // Host-owned timing (via provider from liveContext or outer host wrap):
      // omit explicit durationMs so RunSummary reads from RunTimingProvider.
      // The displayed Duration now matches the value stamped into StoredSession
      // by the host RunTimer at record time.
      // ADR-0021: the verbose surface is driven by args.verbose alone. The
      // detail body renders through the shared viewFindingsGroups producer (same
      // path as the static `fit --verbose | cat` render), not the retired local
      // FindingsBlock.
      const findingsDetail =
        verboseDetail?.kind === 'findings' && verboseDetail.groups.length > 0
          ? verboseDetail
          : undefined;

      const summaryEl = (
        <RunSummary
          passed={envelope.verdict.passed}
          errors={summary.errors}
          warnings={summary.warnings}
          // durationMs omitted — provider supplies host timer value
        />
      );
      const timedSummary = liveContext?.runSession ? (
        <RunTimingProvider timer={liveContext.runSession.timing}>{summaryEl}</RunTimingProvider>
      ) : (
        summaryEl
      );

      return (
        <>
          {staticHeader}
          <Box flexDirection="column">
            {!args.quiet && args.verbose === true && (
              <Box paddingTop={1} flexDirection="column">
                <ResultsTable rows={envelopeToFitRows(envelope)} />
              </Box>
            )}
            {timedSummary}
            {!args.quiet && state.result.warnings && state.result.warnings.length > 0 && (
              <WarningsBlock warnings={state.result.warnings} />
            )}
            {!args.quiet && findingsDetail !== undefined && (
              <Box>{renderToInk(viewFindingsGroups(findingsDetail.groups))}</Box>
            )}
            {!args.quiet && args.verbose !== true && (
              <RunFooterHints
                hints={[
                  VERBOSE_DETAIL_HINT,
                  {
                    text: 'opensip report for HTML report',
                    bold: ['opensip report'],
                  },
                ]}
              />
            )}
            {!args.quiet && state.result.configFound === false && (
              <Box paddingLeft={2}>
                <Text dimColor>
                  No config file found. Run <Text bold>opensip init</Text> to customize targets and
                  settings.
                </Text>
              </Box>
            )}
          </Box>
        </>
      );
    }

    case 'error': {
      return <ErrorMessage message={state.result.message} suggestion={state.result.suggestion} />;
    }
  }
}

/**
 * Compute the Static items list for the current frame. Items are append-only:
 * `'banner'` is present once the run starts; `'header'` joins once checkCount
 * is known (after loading). In quiet mode, the list stays empty so the Static
 * tree renders nothing.
 */
function computeStaticItems(quiet: boolean, checkCount: number | null): ('banner' | 'header')[] {
  if (quiet) return [];
  if (checkCount === null) return ['banner'];
  return ['banner', 'header'];
}

// ---------------------------------------------------------------------------
// Public entry — registered with the CLI via `cli.registerLiveView('fit', ...)`.
// ---------------------------------------------------------------------------

export interface RenderFitLiveOptions {
  readonly setExitCode?: (code: number) => void;
}

/**
 * Render the live `fit` view. Resolves once the underlying Ink app exits with a
 * {@link ToolRunCompletion} carrying the run's `envelope` (for root-owned
 * egress) and `session` contribution (which the HOST persists after this
 * resolves — host-owned-run-timing Phase 2; the component no longer writes the
 * session itself).
 *
 * The fitness tool wires this in via `setUpFitLiveView` / `registerLiveView`.
 * `setExitCode` is the single mutator path on `process.exitCode`; the runner
 * calls it for error-result outcomes (the findings exit is host-owned via the
 * delivered envelope verdict, ADR-0035).
 */
export async function renderFitLive(
  args: FitOptions,
  contextOrDatastore?: DataStore | LiveViewContext,
  options?: RenderFitLiveOptions,
): Promise<ToolRunCompletion> {
  let envelope: SignalEnvelope | undefined;
  let session: ToolSessionContribution | undefined;
  // A raw DataStore arm is accepted for backward compat but no longer threaded
  // (the host owns persistence). Only a LiveViewContext is forwarded.
  const liveContext =
    contextOrDatastore && (contextOrDatastore as LiveViewContext).runSession
      ? (contextOrDatastore as LiveViewContext)
      : undefined;
  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <FitRunner
          args={args}
          setExitCode={options?.setExitCode}
          onEnvelope={(e) => {
            envelope = e;
          }}
          onSession={(c) => {
            session = c;
          }}
          liveContext={liveContext}
        />
      </ClockProvider>
    </ThemeProvider>,
  );
  await app.waitUntilExit();
  // Trailing newline so shell prompt starts on a new line.
  process.stdout.write('\n');
  // host-owned-run-timing Phase 3: the host persists the returned session
  // contribution after this live renderer resolves.
  return { envelope, session };
}
