import { mapToolErrorToExitCode, type CommandResult } from '@opensip-cli/contracts';
import {
  SystemError,
  ToolError,
  currentLogger,
  currentScope,
  type CommandMountContext,
  type LiveViewContext,
  type ReportFailureDetail,
  type CommandSpec,
} from '@opensip-cli/core';
import { RunRepo } from '@opensip-cli/session-store';

import { currentSuiteRunContext, type RunActionHooks } from '../bootstrap/run-plane.js';
import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import { emitCommandResult } from './mount-result-command.js';
import {
  commandLabel,
  isDelegatedCompletion,
  projectStandaloneRun,
} from './run-ledger-standalone.js';

import type { DataStore } from '@opensip-cli/datastore';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const WIRING_INVALID = hostErrorCatalog.require('CLI.HOST.WIRING_INVALID');

export async function runCommandSpecAction<TCtx extends CommandMountContext>(
  spec: CommandSpec<unknown, TCtx>,
  optsWithArgs: Record<string, unknown>,
  positionals: readonly unknown[],
  ctx: TCtx,
  hooks: RunActionHooks = {},
): Promise<void> {
  let failureReported = false;
  let result: unknown;
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
      return;
    }
    result = await spec.handler(optsWithArgs, actionCtx);
    diagnostics?.event('execute', 'debug', `command '${spec.name}' completed`);
    hooks.completeRun?.(result);
    if (failureReported && result === undefined) {
      return;
    }
    await dispatchOutput(result, spec, optsWithArgs, positionals, ctx);
  } catch (error) {
    if (error instanceof ToolError) {
      if (ctx.reportFailure !== undefined) {
        await ctx.reportFailure({
          error,
          jsonRequested: optsWithArgs.json === true,
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
      return;
    }
    throw error;
  } finally {
    await finalizeCommandEvidence({
      spec,
      opts: optsWithArgs,
      positionals,
      ctx,
      hooks,
      result,
    });
  }
}

async function finalizeCommandEvidence<TCtx extends CommandMountContext>(input: {
  readonly spec: CommandSpec<unknown, TCtx>;
  readonly opts: Readonly<Record<string, unknown>>;
  readonly positionals: readonly unknown[];
  readonly ctx: TCtx;
  readonly hooks: RunActionHooks;
  readonly result?: unknown;
}): Promise<void> {
  if (input.hooks.finalizeRun === undefined) return;
  const log = currentLogger();
  try {
    const skipDelegatedSupervisor = hasProvenDelegatedChild(input);
    const projection = projectStandaloneRun({
      spec: input.spec,
      opts: input.opts,
      positionals: input.positionals,
      ctx: input.ctx,
      stagedSession: input.hooks.currentStagedSession?.(),
      stagedEnvelope: input.hooks.currentStagedEnvelope?.(),
      correlationRunId: currentScope()?.runId,
      skipDelegatedSupervisor,
      suppressParent: currentSuiteRunContext() !== undefined,
    });
    const finalized = await input.hooks.finalizeRun(
      projection === undefined ? undefined : { run: projection.evidence },
    );
    if (finalized.status === 'committed' && projection?.missingEvidence === true) {
      log.warn?.({
        evt: 'cli.run-ledger.standalone_missing_evidence',
        module: 'cli:standalone-run-ledger',
        runId: projection.evidence.run.id,
        tool: projection.tool,
        command: projection.command,
        msg: 'Verdict-producing command completed without a staged session or signal envelope.',
      });
    }
  } catch (error) {
    // Persistence/report finalization is secondary to the Tool verdict. Custom
    // host contexts may supply their own hook, so keep this boundary defensive.
    log.warn?.({
      evt: 'cli.run-evidence.finalize_failed',
      module: 'cli:run-plane',
      command: commandLabel(input.spec),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Preserve the subprocess-supervisor de-duplication rule without contaminating
 * the standalone projection with a repository dependency.
 */
function hasProvenDelegatedChild<TCtx extends CommandMountContext>(input: {
  readonly spec: CommandSpec<unknown, TCtx>;
  readonly result?: unknown;
}): boolean {
  if (!isDelegatedCompletion(input.result)) return false;
  const log = currentLogger();
  const correlationRunId = currentScope()?.runId;
  const tool = input.spec.parent ?? input.spec.name;
  const command = commandLabel(input.spec);
  const delegatedAt = input.result.execution?.startedAt;
  let proven = false;
  try {
    const datastore = currentScope()?.datastore() as DataStore | null | undefined;
    proven =
      datastore != null &&
      correlationRunId !== undefined &&
      delegatedAt !== undefined &&
      new RunRepo(datastore).hasImplicitRunForCommand(correlationRunId, tool, command, delegatedAt);
  } catch {
    // @swallow-ok fail-closed: an unprovable implicit-run link must read as unproven, and this is a correlation nicety that must never fail the command
    proven = false;
  }
  if (proven) {
    log.info?.({
      evt: 'cli.run-ledger.delegated_parent_skipped',
      module: 'cli:standalone-run-ledger',
      correlationRunId,
      tool,
      command,
      delegatedAt,
    });
    return true;
  }
  log.warn?.({
    evt: 'cli.run-ledger.delegated_evidence_missing',
    module: 'cli:standalone-run-ledger',
    ...(correlationRunId === undefined ? {} : { correlationRunId }),
    tool,
    command,
    ...(delegatedAt === undefined ? {} : { delegatedAt }),
    msg: 'Delegated command returned without a correlated child run; recording a missing-evidence fault.',
  });
  return false;
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
          {
            code: WIRING_INVALID.code,
            definition: WIRING_INVALID,
            metadata: { condition: 'command-result-undefined' },
          },
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
