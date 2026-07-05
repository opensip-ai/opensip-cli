import {
  type OptionSpec,
  type ArgSpec,
  type PrimaryCommandSpecDraft,
  type ToolCliContext,
  type ToolRunCompletion,
  type ToolSessionContribution,
} from '@opensip-cli/core';

import { emitAgentFilteredJsonOutput } from './agent-filters.js';
import { definePrimaryRunCommand } from './command-presets.js';
import { EXIT_CODES } from './exit-codes.js';
import {
  runHostGateDispatch,
  type HostGateDeliveryOptions,
  type RunHostGateDispatchInput,
} from './gate-dispatch.js';
import {
  deliveryLifecycleEvent,
  emitAnalysisLifecycleEvent,
  runLifecycleEvent,
} from './run-lifecycle-events.js';

import type { SignalEnvelope } from './signal-envelope.js';

/** Common host-owned flags accepted by first-party analysis run commands. */
export interface AnalysisRunCommandOptions {
  readonly cwd: string;
  readonly json?: boolean;
  readonly reportTo?: string;
  readonly apiKey?: string;
  readonly open?: boolean;
  readonly sarif?: string;
  readonly filter?: readonly string[];
  readonly top?: string;
  readonly raw?: boolean;
  readonly gateSave?: boolean;
  readonly gateCompare?: boolean;
}

/** Inputs used to render human-readable presentation for a completed analysis run. */
export interface AnalysisRunPresentationInput<TOptions, TRequest, TResult> {
  readonly options: TOptions;
  readonly request: TRequest;
  readonly result: TResult;
  readonly envelope: SignalEnvelope;
  readonly durationMs: number;
}

/** Context passed to lifecycle hooks after an analysis envelope has been produced. */
export interface AnalysisRunHookInput<TOptions, TRequest, TResult> {
  readonly cli: ToolCliContext;
  readonly options: TOptions;
  readonly request: TRequest;
  readonly result?: TResult;
  readonly envelope: SignalEnvelope;
}

/** Context passed to live-run hooks when the live renderer returns an envelope. */
export interface AnalysisRunLiveHookInput<TOptions, TRequest> {
  readonly cli: ToolCliContext;
  readonly options: TOptions;
  readonly request: TRequest;
  readonly completion: ToolRunCompletion;
  readonly envelope: SignalEnvelope;
}

/** Adapter that lets a tool route TTY rendering through the host-owned live view seam. */
export interface AnalysisRunLiveAdapter<TOptions, TRequest> {
  readonly key: string;
  readonly setUp?: (cli: ToolCliContext) => void;
  readonly shouldUse: (input: {
    readonly options: TOptions;
    readonly request: TRequest;
    readonly cli: ToolCliContext;
  }) => boolean;
  readonly args: (input: { readonly options: TOptions; readonly request: TRequest }) => unknown;
  readonly session?: (
    input: AnalysisRunLiveHookInput<TOptions, TRequest>,
  ) => ToolSessionContribution | undefined;
}

/** Adapter that lets a tool opt into the host-owned baseline gate dispatch path. */
export interface AnalysisRunGateAdapter<TOptions, TRequest> {
  readonly tool: string;
  readonly mode: (input: {
    readonly options: TOptions;
    readonly request: TRequest;
  }) => 'save' | 'compare' | undefined;
  readonly renderSaveLines: RunHostGateDispatchInput['renderSaveLines'];
  readonly renderCompareLines: RunHostGateDispatchInput['renderCompareLines'];
  readonly saveRunFailed?: RunHostGateDispatchInput['saveRunFailed'];
  readonly compareRunFailed?: RunHostGateDispatchInput['compareRunFailed'];
}

/**
 * Complete definition for one host-owned analysis run command.
 *
 * Hook matrix:
 * - static human render: `beforeOutput` → render/presentation →
 *   host delivery/report-open → `afterDelivery` → optional SARIF write.
 * - static JSON: `beforeOutput` → host delivery/report-open →
 *   `afterDelivery` → JSON/raw emission → optional SARIF write, so the emitted
 *   `CommandOutcome.exitCode` observes the host-owned delivery verdict.
 * - gate save/compare: host gate dispatch (including delivery/SARIF/gate render)
 *   → `afterDelivery`; `beforeOutput` is skipped because gate mode has no
 *   normal presentation/JSON emission branch.
 * - live: host live renderer → host delivery/report-open → `afterDelivery` →
 *   optional SARIF write when the live completion carries an envelope.
 */
export interface AnalysisRunCommandInput<
  TOptions extends AnalysisRunCommandOptions,
  TRequest,
  TResult,
> {
  readonly description: string;
  readonly options?: readonly OptionSpec[];
  readonly args?: readonly ArgSpec[];
  readonly normalize: (options: TOptions, cli: ToolCliContext) => TRequest | Promise<TRequest>;
  readonly execute: (
    request: TRequest,
    cli: ToolCliContext,
    options: TOptions,
  ) => TResult | Promise<TResult>;
  readonly envelope: (result: TResult, request: TRequest, options: TOptions) => SignalEnvelope;
  readonly session?: (
    result: TResult,
    request: TRequest,
    options: TOptions,
  ) => ToolSessionContribution | undefined;
  readonly presentation?: (
    input: AnalysisRunPresentationInput<TOptions, TRequest, TResult>,
  ) => unknown;
  readonly live?: AnalysisRunLiveAdapter<TOptions, TRequest>;
  readonly gate?: AnalysisRunGateAdapter<TOptions, TRequest>;
  readonly beforeOutput?: (
    input: AnalysisRunHookInput<TOptions, TRequest, TResult>,
  ) => void | Promise<void>;
  readonly afterDelivery?: (
    input: AnalysisRunHookInput<TOptions, TRequest, TResult>,
  ) => void | Promise<void>;
}

function completionWithSession(session: ToolSessionContribution | undefined): ToolRunCompletion {
  return session === undefined ? {} : { session };
}

function liveCompletionWithSession<TOptions, TRequest>(
  completion: ToolRunCompletion | void,
  input: Omit<AnalysisRunLiveHookInput<TOptions, TRequest>, 'completion'>,
  session: AnalysisRunLiveAdapter<TOptions, TRequest>['session'] | undefined,
): ToolRunCompletion {
  const base = completion ?? {};
  const contribution = session?.({ ...input, completion: base });
  if (contribution !== undefined) return { ...base, session: contribution };
  return base;
}

function deliveryOptions(options: AnalysisRunCommandOptions): HostGateDeliveryOptions {
  return {
    cwd: options.cwd,
    ...(options.reportTo === undefined ? {} : { reportTo: options.reportTo }),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  };
}

async function deliverSignalsAndMaybeOpenReport<
  TOptions extends AnalysisRunCommandOptions,
  TRequest,
  TResult,
>(cli: ToolCliContext, input: AnalysisRunHookInput<TOptions, TRequest, TResult>): Promise<void> {
  emitAnalysisLifecycleEvent(
    cli,
    deliveryLifecycleEvent('analysis.delivery.started', {
      tool: input.envelope.tool,
      runId: input.envelope.runId,
    }),
  );
  try {
    await cli.deliverSignals(input.envelope, deliveryOptions(input.options));
    await cli.maybeOpenReport({
      openRequested: input.options.open === true,
      jsonOutput: input.options.json === true,
    });
    emitAnalysisLifecycleEvent(
      cli,
      deliveryLifecycleEvent('analysis.delivery.completed', {
        tool: input.envelope.tool,
        runId: input.envelope.runId,
      }),
    );
  } catch (error) {
    emitAnalysisLifecycleEvent(
      cli,
      deliveryLifecycleEvent('analysis.delivery.failed', {
        tool: input.envelope.tool,
        runId: input.envelope.runId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}

async function writeSarifIfRequested(
  cli: ToolCliContext,
  envelope: SignalEnvelope,
  path: string | undefined,
): Promise<void> {
  if (path !== undefined && path !== '') {
    await cli.writeSarif(envelope, path);
  }
}

function toVoid(): void {
  return;
}

function runAfterDeliveryHooks<TOptions extends AnalysisRunCommandOptions, TRequest, TResult>(
  input: AnalysisRunCommandInput<TOptions, TRequest, TResult>,
  hookInput: AnalysisRunHookInput<TOptions, TRequest, TResult>,
  beforeSarif?: () => void | Promise<void>,
): Promise<void> {
  return Promise.resolve(input.afterDelivery?.(hookInput))
    .then(() => beforeSarif?.())
    .then(toVoid);
}

async function runOrderedStaticDeliveryEffects<
  TOptions extends AnalysisRunCommandOptions,
  TRequest,
  TResult,
>(
  input: AnalysisRunCommandInput<TOptions, TRequest, TResult>,
  cli: ToolCliContext,
  hookInput: AnalysisRunHookInput<TOptions, TRequest, TResult>,
  options: TOptions,
  beforeSarif?: () => void | Promise<void>,
): Promise<void> {
  // @fitness-ignore-next-line async-waterfall-detection -- Delivery, hooks, optional JSON emit, and SARIF are ordered host side effects.
  await deliverSignalsAndMaybeOpenReport(cli, hookInput);
  await runAfterDeliveryHooks(input, hookInput, beforeSarif);
  await writeSarifIfRequested(cli, hookInput.envelope, options.sarif);
}

async function runStaticAnalysis<TOptions extends AnalysisRunCommandOptions, TRequest, TResult>(
  input: AnalysisRunCommandInput<TOptions, TRequest, TResult>,
  options: TOptions,
  request: TRequest,
  cli: ToolCliContext,
): Promise<ToolRunCompletion> {
  const startedAt = Date.now();
  const result = await input.execute(request, cli, options);
  const envelope = input.envelope(result, request, options);
  const hookInput = { cli, options, request, result, envelope };

  const gate = input.gate;
  const gateMode = gate?.mode({ options, request });
  if (gate !== undefined && gateMode !== undefined) {
    await runHostGateDispatch({
      cli,
      tool: gate.tool,
      envelope,
      mode: gateMode,
      deliver: deliveryOptions(options),
      sarifPath: options.sarif,
      renderSaveLines: gate.renderSaveLines,
      renderCompareLines: gate.renderCompareLines,
      ...(gate.saveRunFailed === undefined ? {} : { saveRunFailed: gate.saveRunFailed }),
      ...(gate.compareRunFailed === undefined ? {} : { compareRunFailed: gate.compareRunFailed }),
    });
    await input.afterDelivery?.(hookInput);
    return completionWithSession(input.session?.(result, request, options));
  }

  await input.beforeOutput?.(hookInput);
  if (options.json === true) {
    await runOrderedStaticDeliveryEffects(input, cli, hookInput, options, () => {
      emitAgentFilteredJsonOutput(cli, envelope, options);
    });
    return completionWithSession(input.session?.(result, request, options));
  } else if (input.presentation !== undefined) {
    await cli.render(
      await input.presentation({
        options,
        request,
        result,
        envelope,
        durationMs: Math.max(0, Date.now() - startedAt),
      }),
    );
  }

  await runOrderedStaticDeliveryEffects(input, cli, hookInput, options);

  return completionWithSession(input.session?.(result, request, options));
}

async function runLiveAnalysis<TOptions extends AnalysisRunCommandOptions, TRequest, TResult>(
  input: AnalysisRunCommandInput<TOptions, TRequest, TResult>,
  options: TOptions,
  request: TRequest,
  cli: ToolCliContext,
): Promise<ToolRunCompletion> {
  const live = input.live;
  if (live === undefined) return {};
  live.setUp?.(cli);
  const completion = await cli.renderLive(live.key, live.args({ options, request }));
  const envelope = completion?.envelope as SignalEnvelope | undefined;
  if (envelope === undefined) return completion ?? {};
  const hookInput = { cli, options, request, envelope };
  // @fitness-ignore-next-line async-waterfall-detection -- Live completion delivery, hooks, and SARIF are ordered host side effects.
  await deliverSignalsAndMaybeOpenReport(cli, hookInput);
  await input.afterDelivery?.(hookInput);
  await writeSarifIfRequested(cli, envelope, options.sarif);
  return liveCompletionWithSession(completion, hookInput, live.session);
}

async function runAnalysisCommand<TOptions extends AnalysisRunCommandOptions, TRequest, TResult>(
  input: AnalysisRunCommandInput<TOptions, TRequest, TResult>,
  rawOptions: unknown,
  cli: ToolCliContext,
): Promise<ToolRunCompletion> {
  const options = rawOptions as TOptions;
  if (input.gate !== undefined && options.gateSave === true && options.gateCompare === true) {
    await cli.reportFailure({
      message: 'Error: --gate-save and --gate-compare are mutually exclusive.',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      jsonRequested: options.json === true,
    });
    return {};
  }

  emitAnalysisLifecycleEvent(cli, runLifecycleEvent('analysis.run.started'));
  try {
    const request = await input.normalize(options, cli);
    const gateMode = input.gate?.mode({ options, request });
    const useLive =
      gateMode === undefined && input.live?.shouldUse({ options, request, cli }) === true;
    const completion = useLive
      ? await runLiveAnalysis(input, options, request, cli)
      : await runStaticAnalysis(input, options, request, cli);
    emitAnalysisLifecycleEvent(cli, runLifecycleEvent('analysis.run.completed'));
    return completion;
  } catch (error) {
    emitAnalysisLifecycleEvent(
      cli,
      runLifecycleEvent('analysis.run.failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}

/** Build a primary run command whose lifecycle, delivery, gates, SARIF, and session return are host owned. */
export function defineAnalysisRunCommand<
  TOptions extends AnalysisRunCommandOptions,
  TRequest,
  TResult,
>(
  input: AnalysisRunCommandInput<TOptions, TRequest, TResult>,
): PrimaryCommandSpecDraft<unknown, ToolCliContext> {
  return definePrimaryRunCommand<unknown>({
    description: input.description,
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.args === undefined ? {} : { args: input.args }),
    handler: (rawOptions, cli) => runAnalysisCommand(input, rawOptions, cli),
  });
}
