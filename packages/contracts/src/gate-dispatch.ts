import {
  resolveFailOnDegraded,
  type GateCompareResult,
  type ToolCliContext,
} from '@opensip-cli/core';

import type { SignalEnvelope } from './signal-envelope.js';

/** Delivery options for the host-owned signal sink. */
export interface HostGateDeliveryOptions {
  readonly cwd: string;
  readonly reportTo?: string | undefined;
  readonly apiKey?: string | undefined;
}

export interface HostGateSaveRenderInput {
  readonly envelope: SignalEnvelope;
  /**
   * Effective findings-policy verdict for presentation. This is not always sent
   * as a `deliverSignals` override; when omitted, the host derives the same
   * value from the envelope verdict.
   */
  readonly runFailed: boolean;
}

export interface HostGateCompareRenderInput {
  readonly envelope: SignalEnvelope;
  readonly result: GateCompareResult;
  readonly runFailed: boolean;
}

export type HostGateDispatchResult =
  | {
      readonly mode: 'save';
      readonly runFailed?: boolean;
    }
  | {
      readonly mode: 'compare';
      readonly result: GateCompareResult;
      readonly runFailed: boolean;
    };

export interface RunHostGateDispatchInput {
  /** Tool CLI context exposing the documented host seams. */
  readonly cli: ToolCliContext;
  /** Tool namespace used by the baseline plane and failOnDegraded policy. */
  readonly tool: string;
  /** Fingerprint-stamped signal envelope produced by the tool run. */
  readonly envelope: SignalEnvelope;
  /** Gate operation selected by the command flags. */
  readonly mode: 'save' | 'compare';
  /** Standard signal-delivery options. */
  readonly deliver: HostGateDeliveryOptions;
  /** Optional SARIF side-output path to write after rendering. */
  readonly sarifPath?: string;
  /** Render lines for a successful baseline save. */
  readonly renderSaveLines: (input: HostGateSaveRenderInput) => readonly string[];
  /** Render lines for a baseline compare result. */
  readonly renderCompareLines: (input: HostGateCompareRenderInput) => readonly string[];
  /**
   * Optional gate-save override. Omit this to let `deliverSignals` derive the
   * findings exit from the envelope verdict, matching the normal run path.
   */
  readonly saveRunFailed?: (input: { readonly envelope: SignalEnvelope }) => boolean;
  /**
   * Optional gate-compare override. Defaults to `degraded && failOnDegraded`.
   */
  readonly compareRunFailed?: (input: {
    readonly envelope: SignalEnvelope;
    readonly result: GateCompareResult;
  }) => boolean;
}

function signalDeliveryOptions(
  deliver: HostGateDeliveryOptions,
  runFailed: boolean | undefined,
): Parameters<ToolCliContext['deliverSignals']>[1] {
  const options = {
    cwd: deliver.cwd,
    ...(deliver.reportTo === undefined ? {} : { reportTo: deliver.reportTo }),
    ...(deliver.apiKey === undefined ? {} : { apiKey: deliver.apiKey }),
  };
  return runFailed === undefined ? options : { ...options, runFailed };
}

async function deliverGateSignals(
  input: Pick<RunHostGateDispatchInput, 'cli' | 'envelope' | 'deliver' | 'sarifPath'> & {
    readonly runFailed?: boolean;
  },
): Promise<void> {
  const tasks: Promise<unknown>[] = [
    input.cli.deliverSignals(input.envelope, signalDeliveryOptions(input.deliver, input.runFailed)),
  ];
  if (input.sarifPath !== undefined && input.sarifPath !== '') {
    tasks.push(input.cli.writeSarif(input.envelope, input.sarifPath));
  }
  await Promise.all(tasks);
}

/**
 * Shared host-owned gate tail for `--gate-save` / `--gate-compare`.
 *
 * Tools still own their domain run and presentation line wording. This helper
 * owns the repeated host seam choreography: save/compare the already-stamped
 * envelope, render the `gate-done` result, deliver signals with the correct
 * gate verdict override, and optionally write SARIF.
 */
export async function runHostGateDispatch(
  input: RunHostGateDispatchInput,
): Promise<HostGateDispatchResult> {
  const { cli, tool, envelope } = input;
  if (input.mode === 'save') {
    await cli.saveBaseline(tool, envelope);
    const runFailed = input.saveRunFailed?.({ envelope });
    await cli.render({
      type: 'gate-done',
      lines: input.renderSaveLines({
        envelope,
        runFailed: runFailed ?? !envelope.verdict.passed,
      }),
    });
    await deliverGateSignals({ ...input, runFailed });
    return runFailed === undefined ? { mode: 'save' } : { mode: 'save', runFailed };
  }

  const result = await cli.compareBaseline(tool, envelope);
  const runFailed =
    input.compareRunFailed?.({ envelope, result }) ??
    (result.degraded && resolveFailOnDegraded(tool));
  await cli.render({
    type: 'gate-done',
    lines: input.renderCompareLines({ envelope, result, runFailed }),
  });
  await deliverGateSignals({ ...input, runFailed });
  return { mode: 'compare', result, runFailed };
}
