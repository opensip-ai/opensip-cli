/**
 * dispatch-replay-result — replay one worker {@link ToolCommandResult} through the
 * REAL host {@link ToolCliContext} seams (ADR-0054 dispatch plane).
 *
 * Split out of `dispatch-external-tool-command.ts` (the fork/IPC supervisor) so
 * the replay concern — turning the slim serialized result the worker posted back
 * into host-side output + evidence staging — lives on its own seam. The host is
 * the only process that performs the privileged effect (render / stdout / exit
 * code / final evidence commit).
 */

import { isSignalEnvelope } from '@opensip-cli/contracts';
import { type CommandSpec, type ToolCliContext } from '@opensip-cli/core';

import { dispatchOutput } from '../commands/mount-command-spec.js';

import { type RunActionHooks } from './run-plane.js';

import type { ToolCommandResult } from './tool-command-dispatch-types.js';

/**
 * The host context the supervisor replays through: the full `ToolCliContext` plus
 * the run-action hooks (`completeRun` stages the worker's returned Session for
 * the command-boundary atomic commit). `completeRun` is optional (a lean context
 * carries no run plane), so a test ctx without it is still valid.
 */
export type DispatchHostCtx = ToolCliContext & Partial<RunActionHooks>;

/** The invocation context {@link replayResult} needs to route the handler's return. */
export interface ReplayContext {
  readonly commandName: string;
  /** Parsed opts (with `_args`) — carries `--json`, which `dispatchOutput` reads. */
  readonly opts: Record<string, unknown>;
  readonly positionals: readonly unknown[];
}

/**
 * Replay the worker's slim {@link ToolCommandResult} through the REAL host
 * {@link ToolCliContext} seams. Two output channels are replayed, exactly
 * mirroring the in-process path:
 *
 *   - The handler's RETURN value (`result.returned`) for the return-valued modes
 *     (`command-result` / `signal-envelope`) is routed through the SAME
 *     {@link dispatchOutput} seam the in-process action uses, so the `--json`
 *     short-circuit vs. human `render` decision is byte-identical regardless of
 *     whether the command ran in-process or in the worker (ADR-0027 parity). This
 *     is the fix for the worker-by-default flip silently dropping a
 *     `command-result` handler's output (e.g. `fit list`): the FRR seam replay
 *     below never captured it, because those handlers RETURN, they do not `ctx.*`.
 *   - The FRR seam fields (`render`/`envelope`/`json`/`raw`/`error`) capture
 *     EXPLICIT `ctx.*` emitter calls a handler made; replayed through their host
 *     counterparts. Populated only for handlers that emit via seams (e.g. an
 *     envelope handler calling `ctx.emitEnvelope`), never together with `returned`
 *     for the same payload.
 *
 * The exit code is applied LAST so it is the final word (matching the in-process
 * `setExitCode` semantics).
 */
export async function replayResult(
  result: ToolCommandResult,
  ctx: DispatchHostCtx,
  invocation: ReplayContext,
): Promise<void> {
  // Stage host evidence before any replayed output can mutate or throw. The
  // run-plane validates/captures only a real SignalEnvelope from these bounded
  // worker-return candidates.
  const completionEnvelope = [
    result.completionEnvelope,
    result.returned,
    result.envelope,
    result.render,
  ]
    .map(envelopeFromReplayCandidate)
    .find((candidate) => candidate !== undefined);
  if (result.session !== undefined || completionEnvelope !== undefined) {
    ctx.completeRun?.({
      ...(result.session === undefined ? {} : { session: result.session }),
      ...(completionEnvelope === undefined ? {} : { envelope: completionEnvelope }),
    });
  }
  if (result.reportedFailure !== undefined) {
    await ctx.reportFailure(result.reportedFailure);
  }
  if (result.error !== undefined) {
    ctx.emitError(result.error);
  }
  // Return-valued modes: route the raw return through the shared dispatch seam so
  // the host applies the identical `--json`/render routing the in-process path
  // would. A synthetic spec carries just what `dispatchOutput` reads (name +
  // output mode).
  if (result.returned !== undefined) {
    const replaySpec = {
      name: invocation.commandName,
      output: result.output,
    } as CommandSpec<unknown, DispatchHostCtx>;
    // Replay is the OUTPUT leg of dispatch; the lifecycle events (dispatch start +
    // worker-resolved) are emitted by the caller (dispatchExternalToolCommand), so
    // a duplicate emit here would be noise.
    await dispatchOutput(result.returned, replaySpec, invocation.opts, invocation.positionals, ctx); // observability-ok
  }
  if (result.render !== undefined) {
    await ctx.render(result.render);
  }
  if (result.envelope !== undefined) {
    ctx.emitEnvelope(result.envelope);
  }
  if (result.json !== undefined) {
    ctx.emitJson(result.json);
  }
  if (result.raw !== undefined) {
    ctx.emitRaw(result.raw);
  }
  if (result.exitCode !== undefined) {
    ctx.setExitCode(result.exitCode);
  }
}

function envelopeFromReplayCandidate(value: unknown): unknown {
  if (isSignalEnvelope(value)) return value;
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as {
    readonly envelope?: unknown;
    readonly result?: unknown;
  };
  if (isSignalEnvelope(record.envelope)) return record.envelope;
  if (record.result === null || typeof record.result !== 'object') return undefined;
  const nested = record.result as { readonly envelope?: unknown };
  return isSignalEnvelope(nested.envelope) ? nested.envelope : undefined;
}
