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
import {
  currentLogger,
  currentScope,
  type LiveViewContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';
import { render, useApp } from 'ink';
import React, { useEffect, useRef, useState } from 'react';

import { scrubErrorMessage } from './scrub-error-message.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

/** Open string so new tools can contribute live views without editing cli-live. */
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
  readonly onEnvelope?: (envelope: SignalEnvelope) => void | Promise<void>;
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
          const message = scrubErrorMessage(outcome.message);
          logger.error({ evt: 'cli.liveview.run.error', tool: spec.tool, message });
          glue.setExitCode?.(outcome.exitCode);
          setState({
            phase: 'error',
            message,
            ...(outcome.suggestion === undefined ? {} : { suggestion: outcome.suggestion }),
          });
          setTimeout(() => exit(), 50);
          return;
        }

        logger.info({ evt: 'cli.liveview.run.complete', tool: spec.tool });

        if (outcome.envelope !== undefined) {
          await glue.onEnvelope?.(outcome.envelope);
        }

        const completion: ToolRunCompletion = {
          ...(outcome.envelope === undefined ? {} : { envelope: outcome.envelope }),
          ...(outcome.session === undefined ? {} : { session: outcome.session }),
        };
        onDone(completion);

        const doneSubscribe = doneSubscribeRef.current;
        setState({
          phase: 'done',
          ...(spec.progressOnDone === true && doneSubscribe !== undefined
            ? { subscribe: doneSubscribe }
            : {}),
          data: outcome.done,
        });
        setTimeout(() => exit(), 50);
      } catch (error) {
        if (cancelled) return;
        const raw = error instanceof Error ? error.message : String(error);
        const message = scrubErrorMessage(raw);
        logger.error({ evt: 'cli.liveview.run.error', tool: spec.tool, message });
        glue.setExitCode?.(1);
        setState({ phase: 'error', message });
        setTimeout(() => exit(), 50);
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
 * Render a tool live view through the shared shell. Resolves once the Ink app
 * exits with the captured {@link ToolRunCompletion}.
 */
export async function runToolLiveView(
  spec: LiveRunSpec,
  glue: HostGlue = {},
): Promise<ToolRunCompletion> {
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
