/**
 * runToolLiveView — shared live-run state machine + produce() seam.
 *
 * Consolidates the Ink lifecycle duplicated across fit/graph/sim/yagni runners:
 * loading → running → done | error, session/envelope capture, setExitCode on
 * hard errors, and the ThemeProvider/ClockProvider render boundary.
 */

import {
  ClockProvider,
  LiveRun,
  ThemeProvider,
  type LiveRunDoneData,
  type LiveRunHeaderMeta,
  type LiveRunState,
  type LiveRunUi,
  type ProgressCallback,
  type ProgressEvent,
  type ProgressSurface,
} from '@opensip-cli/cli-ui';
import { mapToolErrorToExitCode } from '@opensip-cli/contracts';
import {
  currentLogger,
  currentScope,
  isEmbeddedRender,
  ToolError,
  type LiveViewContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { render, useApp } from 'ink';
import React, { useEffect, useRef, useState } from 'react';

import { enrichDoneWithEnvelope } from './enrich-done.js';
import { scrubErrorMessage } from './scrub-error-message.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

/** Open string so new tools can contribute live views without editing cli-live. */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- semantic boundary name (P1-F7)
export type LiveRunTool = string;

export type LiveRunOutcome =
  | {
      readonly kind: 'done';
      readonly done: LiveRunDoneData;
      readonly session?: ToolSessionContribution;
      readonly envelope?: SignalEnvelope;
    }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly exitCode: number;
      readonly suggestion?: string;
    };

export interface LiveRunProduceHelpers {
  readonly setHeaderMetadata: (metadata: readonly LiveRunHeaderMeta[]) => void;
  readonly setShowRunHeader: (show: boolean) => void;
  readonly setRunning: (subscribe: (cb: ProgressCallback) => void) => void;
}

type LiveRunDoneOutcome = Extract<LiveRunOutcome, { kind: 'done' }>;
type LiveRunErrorOutcome = Extract<LiveRunOutcome, { kind: 'error' }>;

function durationFromSnapshot(
  summaryDurationMs: number | undefined,
  completionSnapshot: { readonly durationMs: number } | undefined,
): { readonly durationMs: number } | Record<string, never> {
  if (summaryDurationMs !== undefined || completionSnapshot === undefined) return {};
  return { durationMs: completionSnapshot.durationMs };
}

function buildDoneData(
  outcome: LiveRunDoneOutcome,
  completionSnapshot: { readonly durationMs: number } | undefined,
): LiveRunDoneData {
  return {
    ...outcome.done,
    summary: {
      ...outcome.done.summary,
      ...durationFromSnapshot(outcome.done.summary.durationMs, completionSnapshot),
    },
  };
}

function buildCompletion(outcome: LiveRunDoneOutcome): ToolRunCompletion {
  return {
    ...(outcome.envelope === undefined ? {} : { envelope: outcome.envelope }),
    ...(outcome.session === undefined ? {} : { session: outcome.session }),
  };
}

function doneSubscribePatch(
  progressOnDone: boolean | undefined,
  doneSubscribe: ((cb: ProgressCallback) => void) | undefined,
): { readonly subscribe: (cb: ProgressCallback) => void } | Record<string, never> {
  if (progressOnDone === true && doneSubscribe !== undefined) {
    return { subscribe: doneSubscribe };
  }
  return {};
}

function applyLiveError(
  outcome: LiveRunErrorOutcome,
  deps: {
    readonly logger: ReturnType<typeof currentLogger>;
    readonly tool: string;
    readonly glue: { readonly setExitCode?: (code: number) => void };
    readonly setState: (state: LiveRunState) => void;
    readonly exit: () => void;
  },
): void {
  const message = scrubErrorMessage(outcome.message);
  deps.logger.error({ evt: 'cli.liveview.run.error', tool: deps.tool, message });
  deps.glue.setExitCode?.(outcome.exitCode);
  deps.setState({
    phase: 'error',
    message,
    ...(outcome.suggestion === undefined ? {} : { suggestion: outcome.suggestion }),
  });
  setTimeout(() => deps.exit(), 50);
}

function applyThrownLiveError(
  error: unknown,
  deps: {
    readonly logger: ReturnType<typeof currentLogger>;
    readonly tool: string;
    readonly glue: { readonly setExitCode?: (code: number) => void };
    readonly setState: (state: LiveRunState) => void;
    readonly exit: () => void;
  },
): void {
  const raw = error instanceof Error ? error.message : String(error);
  const message = scrubErrorMessage(raw);
  deps.logger.error({ evt: 'cli.liveview.run.error', tool: deps.tool, message });
  // Preserve ADR-0020 taxonomy (e.g. ConfigurationError → exit 2), not hard-coded 1.
  const exitCode = error instanceof ToolError ? mapToolErrorToExitCode(error) : 1;
  deps.glue.setExitCode?.(exitCode);
  deps.setState({ phase: 'error', message });
  setTimeout(() => deps.exit(), 50);
}

export interface LiveRunSpec {
  readonly tool: LiveRunTool;
  readonly meta: { readonly title: string; readonly description: string };
  readonly surface: ProgressSurface;
  readonly loadingSurface?: ProgressSurface;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly progressOnDone?: boolean;
  readonly loadingMessage?: string;
  readonly initialHeaderMetadata?: readonly LiveRunHeaderMeta[];
  readonly initialShowRunHeader?: boolean;
  readonly projectPath?: string;
  readonly walkedUp?: number;
  readonly produce: (
    emit: (event: ProgressEvent) => void,
    helpers: LiveRunProduceHelpers,
  ) => Promise<LiveRunOutcome>;
}

export interface HostGlue {
  readonly setExitCode?: (code: number) => void;
  readonly liveContext?: LiveViewContext;
}

interface LiveRunnerProps {
  readonly spec: LiveRunSpec;
  readonly glue: HostGlue;
  readonly onDone: (completion: ToolRunCompletion) => void;
}

function canPatchConsole(): boolean {
  return typeof (console as Console & { Console?: unknown }).Console === 'function';
}

function LiveRunner({ spec, glue, onDone }: LiveRunnerProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<LiveRunState>({ phase: 'loading' });
  const [headerMetadata, setHeaderMetadata] = useState<readonly LiveRunHeaderMeta[] | undefined>(
    spec.initialHeaderMetadata,
  );
  const [showRunHeader, setShowRunHeader] = useState(spec.initialShowRunHeader ?? true);
  const doneSubscribeRef = useRef<((cb: ProgressCallback) => void) | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const logger = currentLogger();
    logger.info({ evt: 'cli.liveview.run.start', tool: spec.tool });

    const progressHistory: ProgressEvent[] = [];
    let activeProgressListener: ProgressCallback | undefined;
    const publishProgressEvent = (event: ProgressEvent): void => {
      progressHistory.push(event);
      activeProgressListener?.(event);
    };
    const subscribeProgress =
      (subscribe: (cb: ProgressCallback) => void) =>
      (cb: ProgressCallback): void => {
        activeProgressListener = cb;
        for (const event of progressHistory) cb(event);
        subscribe(publishProgressEvent);
      };
    const emit = (event: ProgressEvent): void => {
      publishProgressEvent(event);
    };

    const helpers: LiveRunProduceHelpers = {
      setHeaderMetadata: (metadata) => {
        if (!cancelled) setHeaderMetadata(metadata);
      },
      setShowRunHeader: (show) => {
        if (!cancelled) setShowRunHeader(show);
      },
      setRunning: (subscribe) => {
        if (cancelled) return;
        const bridgedSubscribe = subscribeProgress(subscribe);
        doneSubscribeRef.current = bridgedSubscribe;
        setState({
          phase: 'running',
          subscribe: bridgedSubscribe,
        });
      },
    };

    void (async () => {
      try {
        const outcome = await spec.produce(emit, helpers);
        if (cancelled) return;

        if (outcome.kind === 'error') {
          applyLiveError(outcome, { logger, tool: spec.tool, glue, setState, exit });
          return;
        }

        logger.info({ evt: 'cli.liveview.run.complete', tool: spec.tool });
        const completionSnapshot = glue.liveContext?.runSession.timing.complete();
        const doneData = buildDoneData(outcome, completionSnapshot);
        onDone(buildCompletion(outcome));
        setState({
          phase: 'done',
          ...doneSubscribePatch(spec.progressOnDone, doneSubscribeRef.current),
          data: enrichDoneWithEnvelope(doneData, outcome.envelope),
        });
        setTimeout(() => exit(), 50);
      } catch (error) {
        if (cancelled) return;
        applyThrownLiveError(error, { logger, tool: spec.tool, glue, setState, exit });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const scope = currentScope();
  const ui: LiveRunUi | undefined = scope?.ui
    ? {
        bannerSize: scope.ui.bannerSize,
        version: scope.ui.version,
        ...(scope.ui.update === undefined ? {} : { update: scope.ui.update }),
      }
    : undefined;

  return (
    <LiveRun
      meta={spec.meta}
      surface={spec.surface}
      loadingSurface={spec.loadingSurface}
      state={state}
      verbose={spec.verbose}
      quiet={spec.quiet}
      timer={glue.liveContext?.runSession?.timing}
      ui={ui}
      projectPath={spec.projectPath ?? scope?.projectContext?.projectRoot}
      walkedUp={spec.walkedUp ?? scope?.projectContext?.walkedUp}
      headerMetadata={headerMetadata}
      showRunHeader={showRunHeader}
      loadingMessage={spec.loadingMessage}
    />
  );
}

/**
 * Run a tool's `produce()` HEADLESS — no Ink, no banner, no output. Used when the
 * run is an embedded suite step ({@link isEmbeddedRender}): the tool's work still
 * runs and its envelope/session are still returned (and captured by the host via
 * the egress seams), but the terminal stays silent so the suite owns the visible
 * output. The live-only helpers (`setHeaderMetadata`/`setShowRunHeader`/
 * `setRunning`) and progress `emit` are no-ops. A thrown `produce` propagates to
 * the host (the suite step runner records it as a step fault); a `kind:'error'`
 * outcome sets the exit code (captured by the host) and returns no envelope.
 */
/** Inert callback for the headless path's live-only hooks + progress emit. */
const HEADLESS_NOOP = (): void => {
  // no-op: embedded steps render nothing, so header/running/progress hooks are inert
};

async function runToolLiveHeadless(spec: LiveRunSpec, glue: HostGlue): Promise<ToolRunCompletion> {
  const logger = currentLogger();
  logger.info({ evt: 'cli.liveview.run.start', tool: spec.tool });
  const outcome = await spec.produce(HEADLESS_NOOP, {
    setHeaderMetadata: HEADLESS_NOOP,
    setShowRunHeader: HEADLESS_NOOP,
    setRunning: HEADLESS_NOOP,
  });
  if (outcome.kind === 'error') {
    logger.error({
      evt: 'cli.liveview.run.error',
      tool: spec.tool,
      message: scrubErrorMessage(outcome.message),
    });
    glue.setExitCode?.(outcome.exitCode);
    return {};
  }
  logger.info({ evt: 'cli.liveview.run.complete', tool: spec.tool });
  return {
    ...(outcome.envelope === undefined ? {} : { envelope: outcome.envelope }),
    ...(outcome.session === undefined ? {} : { session: outcome.session }),
  };
}

/**
 * Render a tool live view through the shared shell. Resolves once the Ink app
 * exits with the captured {@link ToolRunCompletion}. When the run is an embedded
 * suite step, skips Ink entirely and runs {@link runToolLiveHeadless} so only the
 * suite's own live view reaches the terminal.
 */
export async function runToolLiveView(
  spec: LiveRunSpec,
  glue: HostGlue = {},
): Promise<ToolRunCompletion> {
  if (isEmbeddedRender()) {
    return runToolLiveHeadless(spec, glue);
  }

  let completion: ToolRunCompletion = {};

  const app = render(
    <ThemeProvider>
      <ClockProvider>
        <LiveRunner
          spec={spec}
          glue={glue}
          onDone={(c) => {
            completion = c;
          }}
        />
      </ClockProvider>
    </ThemeProvider>,
    { patchConsole: canPatchConsole() },
  );

  await app.waitUntilExit();
  process.stdout.write('\n');
  return completion;
}
