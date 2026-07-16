import { mapToolErrorToExitCode, type CommandResult } from '@opensip-cli/contracts';
import {
  SystemError,
  ToolError,
  currentScope,
  type CommandMountContext,
  type LiveViewContext,
  type ReportFailureDetail,
  type CommandSpec,
} from '@opensip-cli/core';

import { type RunActionHooks } from '../bootstrap/run-plane.js';

import { emitCommandResult } from './mount-result-command.js';
import { persistStandaloneRun } from './run-ledger-standalone.js';

export async function runCommandSpecAction<TCtx extends CommandMountContext>(
  spec: CommandSpec<unknown, TCtx>,
  optsWithArgs: Record<string, unknown>,
  positionals: readonly unknown[],
  ctx: TCtx,
  hooks: RunActionHooks = {},
): Promise<void> {
  let failureReported = false;
  const actionCtx =
    ctx.reportFailure === undefined
      ? ctx
      : (Object.assign(Object.create(ctx), {
          reportFailure: async (detail: ReportFailureDetail) => {
            failureReported = true;
            await ctx.reportFailure?.(detail);
          },
        }) as TCtx);

  const diagnostics = currentScope()?.diagnostics;
  diagnostics?.event('execute', 'debug', `command '${spec.name}' started`);
  hooks.beginRun?.();
  try {
    const dispatched = await hooks.maybeDispatchExternal?.(spec.name, optsWithArgs, positionals);
    if (dispatched === true) {
      diagnostics?.event('execute', 'debug', `command '${spec.name}' dispatched out-of-process`);
      persistStandaloneRun({
        spec,
        opts: optsWithArgs,
        positionals,
        ctx,
        hooks,
      });
      return;
    }
    const result = await spec.handler(optsWithArgs, actionCtx);
    diagnostics?.event('execute', 'debug', `command '${spec.name}' completed`);
    hooks.completeRun?.(result);
    if (failureReported && result === undefined) {
      persistStandaloneRun({
        spec,
        opts: optsWithArgs,
        positionals,
        ctx,
        hooks,
      });
      return;
    }
    await dispatchOutput(result, spec, optsWithArgs, positionals, ctx);
    persistStandaloneRun({
      spec,
      opts: optsWithArgs,
      positionals,
      ctx,
      hooks,
      result,
    });
  } catch (error) {
    if (error instanceof ToolError) {
      if (ctx.reportFailure !== undefined) {
        await ctx.reportFailure({
          error,
          jsonRequested: optsWithArgs.json === true,
        });
        persistStandaloneRun({
          spec,
          opts: optsWithArgs,
          positionals,
          ctx,
          hooks,
        });
        return;
      }
      // No reportFailure seam on this context (lean host/test contexts): still
      // PRESENT the failure — a typed error must never exit silently. `--json`
      // rides the structured emitError seam when present; human mode renders
      // through the guaranteed `render` seam.
      const exitCode = mapToolErrorToExitCode(error);
      ctx.setExitCode(exitCode);
      if (optsWithArgs.json === true && ctx.emitError !== undefined) {
        ctx.emitError({ message: error.message, exitCode, code: error.code });
      } else {
        await ctx.render({ type: 'error', message: error.message, exitCode });
      }
      persistStandaloneRun({
        spec,
        opts: optsWithArgs,
        positionals,
        ctx,
        hooks,
      });
      return;
    }
    persistStandaloneRun({ spec, opts: optsWithArgs, positionals, ctx, hooks });
    throw error;
  }
}

/**
 * The SINGLE output-dispatch seam. The launch `CommandOutcome` wrap is LANDED:
 * the host emit seams this delegates to (`emitCommandResult`, `ctx.emitEnvelope`)
 * now build a `CommandOutcome` and serialize it through the one `renderOutcome`
 * seam. The handler contract and the mounter above stayed byte-identical — all
 * the outer-shape change landed in those seams (north-star §5.5), so the handler
 * keeps returning its pure-domain `CommandResult` / `SignalEnvelope`.
 *
 * Routes the handler's return value by the command's declared
 * {@link CommandSpec.output} mode:
 *   - `command-result`  — the existing `emitCommandResult` seam (json
 *                         short-circuit / `ctx.render`), shared verbatim with
 *                         {@link mountResultCommand}.
 *   - `signal-envelope` — the run-envelope machine-output path: `--json` emits
 *                         through `ctx.emitEnvelope` (the shared ADR-0011
 *                         formatter), otherwise `ctx.render`.
 *   - `raw-stream`      — host renders nothing: the handler already wrote its
 *                         transport/file output, or a host run hook captured an
 *                         internal evidence completion for parent orchestration.
 *   - `live-view`       — the interactive Ink path: `ctx.renderLive(key, args)`
 *                         against the tool's registered renderer.
 *
 * @throws {Error} When a command declares `signal-envelope` / `live-view` output
 *   but the mount context provides no `emitEnvelope` / `renderLive` emitter — a
 *   mis-declared host spec fails loudly here rather than silently no-op'ing.
 */
export async function dispatchOutput<TCtx extends CommandMountContext>(
  result: unknown,
  spec: CommandSpec<unknown, TCtx>,
  opts: Record<string, unknown>,
  positionals: readonly unknown[],
  ctx: TCtx,
): Promise<void> {
  const jsonRequested = opts.json === true;
  switch (spec.output) {
    case 'command-result': {
      if (result === undefined) {
        throw new SystemError(
          `mountCommandSpec: command '${spec.name}' declares output 'command-result' but its handler returned undefined. Return a CommandResult, throw a ToolError, or call reportFailure and return.`,
          { code: 'SYSTEM.COMMAND_RESULT.UNDEFINED' },
        );
      }
      await emitCommandResult(result as CommandResult, {
        render: (r) => ctx.render(r),
        jsonRequested,
        exitCode: ctx.getExitCode?.(),
      });
      return;
    }
    case 'signal-envelope': {
      if (jsonRequested) {
        if (ctx.emitEnvelope === undefined) {
          throw new Error(
            `mountCommandSpec: command '${spec.name}' declares output 'signal-envelope' ` +
              'but the mount context provides no emitEnvelope (host commands are ' +
              "'command-result' / 'raw-stream' only).",
          );
        }
        ctx.emitEnvelope(result);
      } else {
        await ctx.render(result);
      }
      return;
    }
    case 'raw-stream': {
      // The handler owns stdout/file IO, or a host run hook already captured an
      // internal evidence completion for its parent suite. Either way there is
      // no standalone result to render here.
      return;
    }
    case 'live-view': {
      // Dispatch to the tool's registered Ink renderer, keyed by the command
      // NAME (the tool registers its renderer under that key in its setup
      // hook — sim under 'sim', graph under 'graph'). The host forwards the
      // parsed opts + trailing positionals as the args payload; the handler's
      // return value is unused for this mode (the Ink app owns rendering).
      if (ctx.renderLive === undefined) {
        throw new Error(
          `mountCommandSpec: command '${spec.name}' declares output 'live-view' ` +
            'but the mount context provides no renderLive (host commands are ' +
            "'command-result' / 'raw-stream' only).",
        );
      }
      // Thread the host-owned runSession (via LiveViewContext) so the live
      // renderer receives the *same* timer the static path used. Only full
      // ToolCliContext (tool live-view commands) will have runSession; lean
      // host contexts won't reach here.
      const liveContext: LiveViewContext | undefined = ctx.runSession
        ? { runSession: ctx.runSession }
        : undefined;
      await ctx.renderLive(spec.name, { ...opts, _args: positionals }, liveContext);
      return;
    }
  }
}
