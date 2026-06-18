/**
 * sim-runner — owns the live-view state machine for `opensip sim`
 * (ADR-0016). Before this, sim had NO live view: it ran to completion silently
 * and printed a static envelope-to-table. It now renders the shared
 * <LiveProgress> (pool mode) during the run, so the user sees an animated
 * spinner + scenario `completed/total` — including for parallel recipes, where
 * the counter advances as concurrent scenarios finish.
 *
 * Shared presentational primitives (Banner, RunHeader, RunSummary, LiveProgress)
 * come from @opensip-cli/cli-ui. Effectful egress (cloud + --report-to) stays
 * at the composition root: this runner returns the run's SignalEnvelope and the
 * tool's registerLiveView callback delivers it once the Ink app exits.
 *
 * The live run executes OFF the main process (ADR-0028): it forks the CLI to the
 * internal `sim-run-worker` subcommand and relays progress + result over IPC, so
 * the spinner + 80ms clock never block on a synchronous chunk. It falls back to
 * in-process when forking is disabled/unavailable (OPENSIP_CLI_NO_WORKER).
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
  type ProgressEvent,
  type ProgressSurface,
} from '@opensip-cli/cli-ui';
import {
  type ErrorResult,
  type SignalEnvelope,
  type ToolOptions,
  type VerboseDetail,
} from '@opensip-cli/contracts';
import {
  runOffThreadOrInProcess,
  currentScope,
  type LiveViewContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { Box, Static, useApp, render } from 'ink';
import React, { useEffect, useState } from 'react';

import { buildSimulationSessionPayload } from '../persistence/session-payload.js';

import { executeSim } from './sim.js';

const SIM_TOOL_TITLE = 'Simulation Scenarios';
const SIM_TOOL_DESCRIPTION = 'Running simulation scenarios against your codebase.';
const SIM_RUNNING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Running scenarios...' };

/** The sim subcommand's parsed options. `quiet`/`open` are not on the base
 *  ToolOptions (they're added by the command's `.option(...)` flags), so the
 *  live view widens the type to read `quiet`. */
type SimLiveArgs = ToolOptions & { readonly quiet?: boolean; readonly verbose?: boolean };

/**
 * The minimal shape the live `done` frame reads — the same render carrier the
 * static path uses (envelope + optional verboseDetail). envelope-first-presentation:
 * this is `RunPresentation` minus the discriminator; summary duration comes from
 * the host RunTimingProvider, so no `durationMs` is carried here.
 */
interface SimDoneShape {
  readonly envelope: SignalEnvelope;
  readonly verboseDetail?: VerboseDetail;
}

type SimState =
  | { phase: 'loading' }
  | { phase: 'running'; subscribe: (cb: (event: ProgressEvent) => void) => void }
  | { phase: 'done'; result: SimDoneShape }
  | { phase: 'error'; result: ErrorResult };

const SIM_LOADING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Loading scenarios...' };
const NO_PROGRESS: (cb: (event: ProgressEvent) => void) => void = () => {
  // The loading phase has no event stream yet — render a bare animated spinner.
};

/**
 * Run sim through the transport, translating the engine's `(completed, total)`
 * callback into pool ProgressEvents on the `'scenarios'` stage. Hoisted to
 * module scope so the emit translation isn't a deeply-nested function.
 */
function executeSimWithProgress(
  args: SimLiveArgs,
  emit: (event: ProgressEvent) => void,
): ReturnType<typeof executeSim> {
  emit({ type: 'stage-start', stage: 'scenarios', label: 'Running scenarios...' });
  return executeSim(args, {
    onProgress: (completed, total) =>
      emit({ type: 'stage-progress', stage: 'scenarios', completed, total }),
  });
}

/** Props for {@link SimRunner}. Exported so the live-view state machine can be
 *  driven directly under ink-testing-library without spinning up the full
 *  `render()` host (which needs a TTY stdout). */
export interface SimRunnerProps {
  readonly args: SimLiveArgs;
  readonly setExitCode?: (code: number) => void;
  readonly onEnvelope?: (envelope: SignalEnvelope) => void;
  /**
   * Surfaces the run's generic-session contribution (host-owned-run-timing
   * Phase 2). The host persists it after the live view exits — the component
   * must NOT write the session itself.
   */
  readonly onSession?: (contribution: ToolSessionContribution) => void;
  /** From host LiveViewContext — carries the run timer for the RunTimingProvider. */
  readonly liveContext?: LiveViewContext;
}

/** The sim live-view component (loading → running → done/error). Exported for
 *  testing; production renders it through {@link renderSimLive}. */
export function SimRunner({
  args,
  setExitCode,
  onEnvelope,
  onSession,
  liveContext,
}: SimRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<SimState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    // Execute OFF the main process (ADR-0028): fork the CLI to `sim-run-worker`,
    // which re-bootstraps the full scope and streams progress + the final result
    // over IPC, so this process stays free to animate the spinner + 80ms clock.
    // Falls back to the in-process closure (OPENSIP_CLI_NO_WORKER / fork
    // failure) — identical result. The worker reads its serializable args spec
    // from a temp file cleaned up after the run settles.
    const specDir = mkdtempSync(join(tmpdir(), 'sim-worker-'));
    const specPath = join(specDir, 'spec.json');
    writeFileSync(specPath, JSON.stringify(args), 'utf8');
    const run = runOffThreadOrInProcess<ProgressEvent, Awaited<ReturnType<typeof executeSim>>>({
      descriptor: { command: process.argv[1] ?? '', argv: ['sim-run-worker', specPath] },
      inProcess: (emit) => executeSimWithProgress(args, emit),
    });
    setState({ phase: 'running', subscribe: run.onProgress });

    void (async () => {
      let simResult: Awaited<ReturnType<typeof executeSim>>;
      try {
        simResult = await run.result;
      } finally {
        rmSync(specDir, { recursive: true, force: true });
      }
      const { result } = simResult;
      if (cancelled) return;
      if (result.type === 'error') {
        setState({ phase: 'error', result });
        setExitCode?.(result.exitCode);
      } else {
        // ADR-0035: the host owns the findings exit. The live renderer hands the
        // envelope to `setUpSimLiveView` via `onEnvelope`, which calls
        // `deliverSignals`; the root sets the exit from `envelope.verdict.passed`.
        // Host-owned persistence (host-owned-run-timing Phase 2): surface the
        // contribution; the host persists after the live view exits.
        // envelope-first-presentation: `result` is the render-only RunPresentation —
        // cwd comes from `args.cwd` (in scope), recipe from `result.envelope.recipe`.
        if (result.type === 'run-presentation') {
          onSession?.({
            tool: 'sim',
            cwd: args.cwd,
            recipe: result.envelope.recipe,
            score: result.envelope.verdict.score,
            passed: result.envelope.verdict.passed,
            payload: buildSimulationSessionPayload(result.envelope),
          });
        }
        onEnvelope?.(result.envelope);
        setState({
          phase: 'done',
          result: {
            envelope: result.envelope,
            verboseDetail: result.verboseDetail,
          },
        });
      }
      setTimeout(() => exit(), 100);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (state.phase === 'error') {
    return <ErrorMessage message={state.result.message} suggestion={state.result.suggestion} />;
  }

  const scope = currentScope();
  const ui = scope?.ui;
  const walkedUp = scope?.projectContext?.walkedUp;
  const bannerSize = normalizeBannerSize(ui?.bannerSize);
  const recipe = args.recipe ?? 'default';

  const header =
    args.quiet === true ? null : (
      <Static items={['header']}>
        {() => (
          <React.Fragment key="header">
            <Banner
              size={bannerSize}
              version={ui?.version}
              projectPath={args.cwd}
              walkedUp={walkedUp}
              update={ui?.update}
            />
            {bannerSize === 'mini' && ui?.update !== undefined && <UpdateHint />}
            {bannerSize !== 'mini' && <ProjectHeader root={args.cwd} walkedUp={walkedUp} />}
            <RunHeader
              tool={SIM_TOOL_TITLE}
              description={SIM_TOOL_DESCRIPTION}
              metadata={[{ label: 'Recipe', value: recipe }]}
            />
          </React.Fragment>
        )}
      </Static>
    );

  if (state.phase === 'loading') {
    return (
      <>
        {header}
        <Box paddingTop={1}>
          <LiveProgress surface={SIM_LOADING_SURFACE} subscribe={NO_PROGRESS} />
        </Box>
      </>
    );
  }

  if (state.phase === 'running') {
    return (
      <>
        {header}
        <LiveProgress surface={SIM_RUNNING_SURFACE} subscribe={state.subscribe} />
      </>
    );
  }

  const { summary } = state.result.envelope.verdict;
  const { verboseDetail } = state.result;
  const findingsDetail =
    verboseDetail?.kind === 'findings' && verboseDetail.groups.length > 0
      ? verboseDetail
      : undefined;
  return (
    <>
      {header}
      <Box flexDirection="column">
        {args.quiet !== true && findingsDetail !== undefined && (
          <Box>{renderToInk(viewFindingsGroups(findingsDetail.groups))}</Box>
        )}
        {(() => {
          const summaryEl = (
            <RunSummary
              passed={state.result.envelope.verdict.passed}
              errors={summary.errors}
              warnings={summary.warnings}
              // durationMs omitted — provider (from liveContext) supplies host timer
            />
          );
          return liveContext?.runSession ? (
            <RunTimingProvider timer={liveContext.runSession.timing}>{summaryEl}</RunTimingProvider>
          ) : (
            summaryEl
          );
        })()}
        {args.quiet !== true && (
          <RunFooterHints
            hints={
              args.verbose === true
                ? [
                    {
                      text: 'opensip report for HTML report',
                      bold: ['opensip report'],
                    },
                  ]
                : [
                    VERBOSE_DETAIL_HINT,
                    {
                      text: 'opensip report for HTML report',
                      bold: ['opensip report'],
                    },
                  ]
            }
          />
        )}
      </Box>
    </>
  );
}

export interface RenderSimLiveOptions {
  readonly setExitCode?: (code: number) => void;
}

/**
 * Render the live `sim` view. Resolves once the Ink app exits with a
 * {@link ToolRunCompletion} carrying the run's `envelope` (for root-owned
 * egress) and `session` contribution (persisted by the HOST after this
 * resolves — host-owned-run-timing Phase 2; the component no longer writes the
 * session itself).
 */
export async function renderSimLive(
  args: SimLiveArgs,
  options?: RenderSimLiveOptions,
  liveContext?: LiveViewContext,
): Promise<ToolRunCompletion> {
  let envelope: SignalEnvelope | undefined;
  let session: ToolSessionContribution | undefined;
  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <SimRunner
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
  process.stdout.write('\n');
  // host-owned-run-timing Phase 3: the host persists the returned session
  // contribution after this live renderer resolves.
  return { envelope, session };
}
