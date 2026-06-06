/**
 * fit-runner — owns the live-view state machine for `opensip-tools fit`.
 *
 * Layer 5 Phase 3 lifted the fit live view out of `opensip-tools`.
 * The state machine (loading → running → done | error), `executeFit`
 * orchestration, `reportToCloud` post-call, and the Ink/React render
 * tree all live here, in the package that owns the fitness command
 * surface. Adding a fourth tool with a live view requires zero CLI
 * edits — each tool ships its own renderer and registers it via
 * `cli.registerLiveView(key, renderer)`.
 *
 * Shared presentational primitives (Banner, RunHeader, Spinner, theme
 * tokens) come from `@opensip-tools/cli-ui`. Tool-specific render
 * pieces (results table, findings block, cloud-report status) live in
 * `cli/fit-runner-views.tsx`; they're imported here so this module
 * stays focused on the state machine and entry point.
 *
 * Single exit-code write path: errors and shouldFail conditions route
 * through the supplied `setExitCode` callback (`ToolCliContext.setExitCode`)
 * so the CLI keeps its single `process.exitCode` mutator. The
 * historical `process.exitCode = N` writes that lived in FitView are
 * gone.
 */

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
  viewFindingsGroups,
  type ProgressCallback,
  type ProgressEvent,
  type ProgressSurface,
} from '@opensip-tools/cli-ui';
import {
  EXIT_CODES,
  type FitOptions,
  type ErrorResult,
  type FitDoneResult,
  type SignalEnvelope,
} from '@opensip-tools/contracts';
import { createInProcessTransport, currentScope } from '@opensip-tools/core';
import { Box, Static, Text, useApp, render } from 'ink';
import React, { useEffect, useState } from 'react';

import { envelopeToFitRows } from './fit/envelope-view.js';
import {
  ResultsTable,
  WarningsBlock,
} from './fit-runner-views.js';
import { ensureChecksLoaded, executeFit, getEnabledCheckCount } from './fit.js';

import type { DataStore } from '@opensip-tools/datastore';

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
  datastore: DataStore | undefined,
  emit: (event: ProgressEvent) => void,
): ReturnType<typeof executeFit> {
  emit({ type: 'stage-start', stage: 'checks', label: 'Running checks...' });
  return executeFit(args, {
    onProgress: (completed, total) => emit({ type: 'stage-progress', stage: 'checks', completed, total }),
    datastore,
  });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type FitState =
  | { phase: 'loading' }
  | { phase: 'running'; checkCount: number; subscribe: (cb: ProgressCallback) => void }
  | { phase: 'done'; result: FitDoneResult; checkCount: number }
  | { phase: 'error'; result: ErrorResult };

interface FitRunnerProps {
  readonly args: FitOptions;
  readonly datastore?: DataStore;
  readonly setExitCode?: (code: number) => void;
  /** Called with the run's envelope once it completes, for root-owned egress. */
  readonly onEnvelope?: (envelope: SignalEnvelope) => void;
}

function FitRunner({ args, datastore, setExitCode, onEnvelope }: FitRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<FitState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Phase 1: Load checks to get count for header
      await ensureChecksLoaded(args.cwd);
      const checkCount = getEnabledCheckCount();

      if (cancelled) return;

      // Phase 2: Execute through the in-process transport. The engine reports a
      // monotonic (completed, total) pair via `buildFitCallbacks`; the runner
      // translates each into a pool `stage-progress` ProgressEvent that the
      // shared <LiveProgress> renderer folds into the spinner + counter. fit's
      // execution yields to the event loop, so the spinner animates in-process.
      const transport = createInProcessTransport();
      const run = transport.run<ProgressEvent, Awaited<ReturnType<typeof executeFit>>>(
        (emit) => executeFitWithProgress(args, datastore, emit),
      );

      setState({ phase: 'running', checkCount, subscribe: run.onProgress });

      const fitResult = await run.result;

      if (cancelled) return;

      if (fitResult.result.type === 'error') {
        setState({ phase: 'error', result: fitResult.result });
        setExitCode?.(fitResult.result.exitCode);
        setTimeout(() => exit(), 100);
        return;
      }

      const { result } = fitResult as { result: FitDoneResult };

      if (result.shouldFail) {
        setExitCode?.(EXIT_CODES.RUNTIME_ERROR);
      }

      // Effectful egress (cloud + `--report-to`) lives at the composition root
      // now (ADR-0011): `renderFitLive` returns this envelope and the tool's
      // `registerLiveView` callback delivers it once the Ink app exits.
      onEnvelope?.(result.envelope);

      setState({ phase: 'done', result, checkCount });
      setTimeout(() => exit(), 100);
    })();

    return () => { cancelled = true; };
  }, []);

  const recipe = args.tags ? `tags: ${args.tags}` : (args.recipe ?? 'default');

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
          <Banner size={bannerSize} version={ui?.version} projectPath={args.cwd} walkedUp={walkedUp} update={ui?.update} />
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

  const staticHeader = (
    <Static items={staticItems}>
      {renderStaticItem}
    </Static>
  );

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
      const durationMs = envelope.units.reduce((total, u) => total + u.durationMs, 0);
      // ADR-0021: --findings is folded into --verbose at the action seam, so the
      // verbose surface is driven by args.verbose alone. The detail body renders
      // through the shared viewFindingsGroups producer (same path as the static
      // `fit --verbose | cat` render), not the retired local FindingsBlock.
      const findingsDetail =
        verboseDetail?.kind === 'findings' && verboseDetail.groups.length > 0 ? verboseDetail : undefined;
      return (
        <>
          {staticHeader}
          <Box flexDirection="column">
          {!args.quiet && args.verbose === true && (
            <Box paddingTop={1} flexDirection="column">
              <ResultsTable rows={envelopeToFitRows(envelope)} />
            </Box>
          )}
          <RunSummary
            passed={summary.passed}
            failed={summary.failed}
            errors={summary.errors}
            warnings={summary.warnings}
            durationMs={durationMs}
          />
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
                { text: 'opensip-tools dashboard for HTML report', bold: ['opensip-tools dashboard'] },
              ]}
            />
          )}
          {!args.quiet && state.result.configFound === false && (
            <Box paddingLeft={2}>
              <Text dimColor>
                No config file found. Run <Text bold>opensip-tools init</Text> to customize targets and settings.
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
 * Render the live `fit` view. Returns the run's {@link SignalEnvelope} once
 * the underlying Ink app exits (or `undefined` on an error / no-result run).
 *
 * The CLI's `tool.register(cli)` wires this through
 * `cli.registerLiveView('fit', (args) => renderFitLive(args, { ... }))`.
 * `setExitCode` is the single mutator path on `process.exitCode`; the
 * runner calls it for error and `shouldFail` outcomes so the CLI's
 * exit-code seam stays the only writer. The returned envelope lets the tool's
 * registration deliver signals (cloud + `--report-to`) at the composition
 * root after the interactive view exits (ADR-0011 — egress is not in-view).
 */
export async function renderFitLive(
  args: FitOptions,
  datastore?: DataStore,
  options?: RenderFitLiveOptions,
): Promise<SignalEnvelope | undefined> {
  let envelope: SignalEnvelope | undefined;
  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <FitRunner
          args={args}
          datastore={datastore}
          setExitCode={options?.setExitCode}
          onEnvelope={(e) => { envelope = e; }}
        />
      </ClockProvider>
    </ThemeProvider>,
  );
  await app.waitUntilExit();
  // Trailing newline so shell prompt starts on a new line.
  process.stdout.write('\n');
  return envelope;
}
