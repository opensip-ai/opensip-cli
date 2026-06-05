/**
 * sim-runner — owns the live-view state machine for `opensip-tools sim`
 * (ADR-0015). Before this, sim had NO live view: it ran to completion silently
 * and printed a static envelope-to-table. It now renders the shared
 * <LiveProgress> (pool mode) during the run, so the user sees an animated
 * spinner + scenario `completed/total` — including for parallel recipes, where
 * the counter advances as concurrent scenarios finish.
 *
 * Shared presentational primitives (Banner, RunHeader, RunSummary, LiveProgress)
 * come from @opensip-tools/cli-ui. Effectful egress (cloud + --report-to) stays
 * at the composition root: this runner returns the run's SignalEnvelope and the
 * tool's registerLiveView callback delivers it once the Ink app exits.
 *
 * sim's execution already yields to the event loop (awaited scenarios /
 * Promise.all), so the spinner animates in-process — no subprocess needed.
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
  type ProgressEvent,
  type ProgressSurface,
} from '@opensip-tools/cli-ui';
import {
  EXIT_CODES,
  type ErrorResult,
  type SignalEnvelope,
  type ToolOptions,
} from '@opensip-tools/contracts';
import { createInProcessTransport, currentScope } from '@opensip-tools/core';
import { Box, Static, useApp, render } from 'ink';
import React, { useEffect, useState } from 'react';

import { executeSim } from './sim.js';

const SIM_TOOL_TITLE = 'Simulation Scenarios';
const SIM_TOOL_DESCRIPTION = 'Running simulation scenarios against your codebase.';
const SIM_RUNNING_SURFACE: ProgressSurface = { shape: 'pool', label: 'Running scenarios...' };

/** The sim subcommand's parsed options. `quiet`/`open` are not on the base
 *  ToolOptions (they're added by the command's `.option(...)` flags), so the
 *  live view widens the type to read `quiet`. */
type SimLiveArgs = ToolOptions & { readonly quiet?: boolean };

interface SimDoneShape {
  readonly envelope: SignalEnvelope;
  readonly durationMs: number;
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

interface SimRunnerProps {
  readonly args: SimLiveArgs;
  readonly setExitCode?: (code: number) => void;
  readonly onEnvelope?: (envelope: SignalEnvelope) => void;
}

function SimRunner({ args, setExitCode, onEnvelope }: SimRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<SimState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;

    // Build the transport + run inside the effect (no module-level state): the
    // 'running' state carries the subscribe fn, set once the run starts.
    const transport = createInProcessTransport();
    const run = transport.run<ProgressEvent, Awaited<ReturnType<typeof executeSim>>>(
      (emit) => executeSimWithProgress(args, emit),
    );
    setState({ phase: 'running', subscribe: run.onProgress });

    void (async () => {
      const { result } = await run.result;
      if (cancelled) return;
      if (result.type === 'error') {
        setState({ phase: 'error', result });
        setExitCode?.(result.exitCode);
      } else {
        if (result.shouldFail === true) setExitCode?.(EXIT_CODES.RUNTIME_ERROR);
        onEnvelope?.(result.envelope);
        setState({ phase: 'done', result: { envelope: result.envelope, durationMs: result.durationMs } });
      }
      setTimeout(() => exit(), 100);
    })();

    return () => { cancelled = true; };
  }, []);

  if (state.phase === 'error') {
    return <ErrorMessage message={state.result.message} suggestion={state.result.suggestion} />;
  }

  const scope = currentScope();
  const ui = scope?.ui;
  const walkedUp = scope?.projectContext?.walkedUp;
  const bannerSize = normalizeBannerSize(ui?.bannerSize);
  const recipe = args.recipe ?? 'default';

  const header = args.quiet === true ? null : (
    <Static items={['header']}>
      {() => (
        <React.Fragment key="header">
          <Banner size={bannerSize} version={ui?.version} projectPath={args.cwd} walkedUp={walkedUp} update={ui?.update} />
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
  return (
    <>
      {header}
      <Box flexDirection="column">
        <RunSummary
          passed={summary.passed}
          failed={summary.failed}
          errors={summary.errors}
          warnings={summary.warnings}
          durationMs={state.result.durationMs}
        />
        {args.quiet !== true && (
          <RunFooterHints
            hints={[
              { text: 'opensip-tools dashboard for HTML report', bold: ['opensip-tools dashboard'] },
              { text: '--report-to <url> to send to OpenSIP', bold: ['--report-to <url>'] },
            ]}
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
 * Render the live `sim` view. Returns the run's SignalEnvelope once the Ink app
 * exits (or undefined on an error / no-result run) so the composition root can
 * deliver signals (cloud + --report-to) after the interactive view exits.
 */
export async function renderSimLive(
  args: SimLiveArgs,
  options?: RenderSimLiveOptions,
): Promise<SignalEnvelope | undefined> {
  let envelope: SignalEnvelope | undefined;
  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <SimRunner
          args={args}
          setExitCode={options?.setExitCode}
          onEnvelope={(e) => { envelope = e; }}
        />
      </ClockProvider>
    </ThemeProvider>,
  );
  await app.waitUntilExit();
  process.stdout.write('\n');
  return envelope;
}
