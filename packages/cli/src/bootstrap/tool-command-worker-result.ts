/**
 * tool-command-worker-result — pure result-assembly helpers for the external
 * tool command dispatch WORKER (ADR-0054). These translate the worker-side
 * {@link ResultAccumulator} plus the handler's return value into the
 * serializable {@link ToolCommandResult} the supervisor replays through the
 * host's `dispatchOutput`. They hold no effect and never touch `process` — the
 * orchestration/IPC concerns stay in `tool-command-worker-entry.ts`.
 */

import {
  type CommandSpec,
  type ToolCliContext,
  type ToolSessionContribution,
} from '@opensip-cli/core';

import { type ResultAccumulator } from './tool-command-worker-context.js';

import type { ToolCommandFailureClass, ToolCommandResult } from './tool-command-dispatch-types.js';

/** The completion shape a run-producing handler returns (the session leg the host persists). */
export interface MaybeCompletion {
  readonly session?: ToolSessionContribution;
}

/**
 * The output modes whose PAYLOAD is the handler's RETURN value (routed by the
 * in-process `dispatchOutput`): `command-result` (a `CommandResult`) and
 * `signal-envelope` (a `SignalEnvelope`). For these, the worker must carry the
 * return back UNROUTED in `returned` so the supervisor replays it through the SAME
 * `dispatchOutput`. `raw-stream` / `live-view` produce no routable return payload.
 */
function isReturnValuedOutput(output: ToolCommandResult['output']): boolean {
  return output === 'command-result' || output === 'signal-envelope';
}

/** Drain the accumulator + the handler's return into a serializable result. */
export function toResult(
  output: ToolCommandResult['output'],
  acc: ResultAccumulator,
  session: ToolSessionContribution | undefined,
  returned: unknown,
): ToolCommandResult {
  return {
    output,
    ...(acc.render === undefined ? {} : { render: acc.render }),
    ...(acc.envelope === undefined ? {} : { envelope: acc.envelope }),
    ...(acc.json === undefined ? {} : { json: acc.json }),
    ...(acc.raw === undefined ? {} : { raw: acc.raw }),
    ...(acc.error === undefined ? {} : { error: acc.error }),
    ...(acc.reportedFailure === undefined ? {} : { reportedFailure: acc.reportedFailure }),
    ...(acc.exitCode === undefined ? {} : { exitCode: acc.exitCode }),
    ...(session === undefined ? {} : { session }),
    // Carry the handler's return for the return-valued modes so the supervisor
    // routes it via the same `dispatchOutput` the in-process path uses (parity).
    ...(returned === undefined || !isReturnValuedOutput(output) ? {} : { returned }),
  };
}

function hasExplicitFinalResult(acc: ResultAccumulator): boolean {
  return (
    acc.render !== undefined ||
    acc.envelope !== undefined ||
    acc.json !== undefined ||
    acc.raw !== undefined ||
    acc.error !== undefined ||
    acc.reportedFailure !== undefined ||
    acc.exitCode !== undefined
  );
}

/**
 * Fail loud when a return-valued handler (`command-result` / `signal-envelope`)
 * neither returned a value nor recorded an explicit final result — a silent
 * `undefined` would otherwise replay as an empty output. Tagged
 * `tool-handler-throw` so the supervisor surfaces a structured failure.
 */
export function assertReturnValuedHandlerResult(
  commandSpec: CommandSpec<unknown, ToolCliContext>,
  acc: ResultAccumulator,
  returned: unknown,
): void {
  if (!isReturnValuedOutput(commandSpec.output) || returned !== undefined) return;
  if (hasExplicitFinalResult(acc)) return;
  const err = new Error(
    `tool command worker: command '${commandSpec.name}' declares output '${commandSpec.output}' but its handler returned undefined. Return a value, throw, or call reportFailure.`,
  );
  (err as Error & { failureClass: ToolCommandFailureClass }).failureClass = 'tool-handler-throw';
  throw err;
}
