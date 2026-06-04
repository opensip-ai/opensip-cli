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
  normalizeBannerSize,
  ProjectHeader,
  RunFooterHints,
  RunHeader,
  RunSummary,
  Spinner,
  ThemeProvider,
  UpdateHint,
} from '@opensip-tools/cli-ui';
import {
  EXIT_CODES,
  type FitOptions,
  type CliOutput,
  type ErrorResult,
  type FitDoneResult,
} from '@opensip-tools/contracts';
import { currentScope } from '@opensip-tools/core';
import { Box, Static, Text, useApp, render } from 'ink';
import React, { useCallback, useEffect, useState } from 'react';

import { reportFitFindings } from './fit-modes.js';
import {
  CloudReportStatusLine,
  FindingsBlock,
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

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

type FitState =
  | { phase: 'loading' }
  | { phase: 'running'; completed: number; total: number; checkCount: number }
  | { phase: 'done'; result: FitDoneResult; checkCount: number }
  | { phase: 'error'; result: ErrorResult };

interface FitRunnerProps {
  readonly args: FitOptions;
  readonly datastore?: DataStore;
  readonly setExitCode?: (code: number) => void;
}

function FitRunner({ args, datastore, setExitCode }: FitRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<FitState>({ phase: 'loading' });

  // Progress-state machine: `executeFit` calls back with a monotonic
  // (completed, total) pair via `buildFitCallbacks` in fit.ts. The
  // useCallback identity is stable across renders so the underlying
  // `useEffect` does not re-fire on each tick.
  const onProgress = useCallback((completed: number, total: number) => {
    setState((prev) =>
      prev.phase === 'running'
        ? { ...prev, completed, total }
        : prev,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Phase 1: Load checks to get count for header
      await ensureChecksLoaded(args.cwd);
      const checkCount = getEnabledCheckCount();

      if (cancelled) return;
      setState({ phase: 'running', completed: 0, total: 0, checkCount });

      // Phase 2: Execute. Pass `onProgress` so the spinner ticks live,
      // and `datastore` so the run lands in the SQLite session history
      // (the JSON path goes through tool.ts's runJsonMode and threads
      // its own copy).
      const fitResult = await executeFit(args, { onProgress, datastore });

      if (cancelled) return;

      if (fitResult.result.type === 'error') {
        setState({ phase: 'error', result: fitResult.result });
        setExitCode?.(fitResult.result.exitCode);
        setTimeout(() => exit(), 100);
        return;
      }

      const { result, output } = fitResult as { result: FitDoneResult; output: CliOutput };

      // Cloud reporting — shared with the json/gate/non-TTY paths (audit P1-1).
      let finalResult: FitDoneResult = result;
      const reportStatus = await reportFitFindings(output, args);
      if (reportStatus) {
        finalResult = { ...result, reportStatus };
      }

      if (finalResult.shouldFail) {
        setExitCode?.(1);
      } else if (reportStatus && !reportStatus.success) {
        // A `--report-to` upload failure fails the run (EXIT_CODES.REPORT_FAILED,
        // the documented contract), but only when the run otherwise passed — a
        // real check/gate failure (shouldFail above) takes precedence and is
        // never masked by a reporting failure.
        setExitCode?.(EXIT_CODES.REPORT_FAILED);
      }

      setState({ phase: 'done', result: finalResult, checkCount });
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
          <Box paddingLeft={2} paddingTop={1}>
            <Spinner total={0} completed={0} label="Loading checks..." />
          </Box>
        </>
      );
    }

    case 'running': {
      return (
        <>
          {staticHeader}
          <Box paddingLeft={2}>
            <Spinner total={state.total} completed={state.completed} label="Running checks..." />
          </Box>
        </>
      );
    }

    case 'done': {
      return (
        <>
          {staticHeader}
          <Box flexDirection="column">
          {!args.quiet && (args.verbose === true || args.findings === true) && (
            <Box paddingTop={1} flexDirection="column">
              <ResultsTable rows={state.result.rows} />
            </Box>
          )}
          <RunSummary
            passed={state.result.summary.passed}
            failed={state.result.summary.failed}
            errors={state.result.summary.totalErrors}
            warnings={state.result.summary.totalWarnings}
            durationMs={state.result.summary.durationMs}
          />
          {!args.quiet && state.result.warnings && state.result.warnings.length > 0 && (
            <WarningsBlock warnings={state.result.warnings} />
          )}
          {!args.quiet && state.result.findings && (
            <FindingsBlock checks={state.result.findings.checks} />
          )}
          {!args.quiet && state.result.reportStatus && (
            <CloudReportStatusLine status={state.result.reportStatus} />
          )}
          {!args.quiet && args.verbose !== true && args.findings !== true && (
            <RunFooterHints
              hints={[
                { text: 'Use --verbose for detailed results', bold: ['--verbose'] },
                { text: 'opensip-tools dashboard for HTML report', bold: ['opensip-tools dashboard'] },
                { text: '--report-to <url> to send to OpenSIP', bold: ['--report-to <url>'] },
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
 * Render the live `fit` view. Returns once the underlying Ink app exits.
 *
 * The CLI's `tool.register(cli)` wires this through
 * `cli.registerLiveView('fit', (args) => renderFitLive(args, { ... }))`.
 * `setExitCode` is the single mutator path on `process.exitCode`; the
 * runner calls it for error and `shouldFail` outcomes so the CLI's
 * exit-code seam stays the only writer.
 */
export async function renderFitLive(
  args: FitOptions,
  datastore?: DataStore,
  options?: RenderFitLiveOptions,
): Promise<void> {
  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <FitRunner args={args} datastore={datastore} setExitCode={options?.setExitCode} />
      </ClockProvider>
    </ThemeProvider>,
  );
  await app.waitUntilExit();
  // Trailing newline so shell prompt starts on a new line.
  process.stdout.write('\n');
}
