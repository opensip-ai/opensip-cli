/**
 * mount-result-command — action-body helper for CLI-owned subcommands
 * that produce a `CommandResult`.
 *
 * Centralizes the per-subcommand boilerplate every result-producing
 * action body would otherwise repeat:
 *
 *   - Run the supplied handler (sync or async).
 *   - If `--json` was set, emit the result as JSON to stdout and bail
 *     before Ink starts. Bypassing the renderer keeps `--json`
 *     contract-faithful: machine consumers should never see ANSI
 *     escapes or Ink's whitespace adjustments.
 *   - Otherwise route the result through the renderer the dispatcher
 *     wired into the context.
 *
 * Two shapes are exposed:
 *
 *   - `mountResultCommand(cmd, handler)` — opts-only handler. Used by
 *     `init`, `sessions list`, `plugin list`, `plugin sync`.
 *   - `mountResultCommandWithArg(cmd, handler)` — single-positional-arg
 *     handler. Used by `plugin add` / `plugin remove`.
 *
 * Phase 5 of the Layer 5 plan introduces this helper; Phase 6 routes
 * `clear` and `configure` through it (eliminating the last raw-ANSI
 * bypasses).
 */

import { outcomeFromResult } from './assemble-outcome.js';
import { renderOutcome } from './render-outcome.js';

import type { CliCommandsContext } from './shared.js';
import type { CommandResult } from '@opensip-cli/contracts';
import type { Command } from 'commander';

export type CommandHandler<TOpts> = (opts: TOpts) => CommandResult | Promise<CommandResult>;

export interface MountResultCommandOptions<TOpts> {
  readonly ctx: CliCommandsContext;
  /**
   * Pull the `--json` flag value out of the parsed Commander options.
   * The `--json` flag itself is the caller's responsibility — they
   * declare it on their `Command` before mounting. The mount helper
   * doesn't add the flag so each subcommand can keep its own help text.
   */
  readonly jsonFlag?: (opts: TOpts) => boolean | undefined;
}

/**
 * Mount a result-producing handler as the action body of `cmd`.
 * The handler returns a `CommandResult`; `mountResultCommand` handles
 * the `--json` short-circuit and the Ink render dispatch.
 */
export function mountResultCommand<TOpts>(
  cmd: Command,
  handler: CommandHandler<TOpts>,
  opts: MountResultCommandOptions<TOpts>,
): void {
  cmd.action(async (parsedOpts: TOpts) => {
    const result = await handler(parsedOpts);
    await emit(result, opts, parsedOpts);
  });
}

export type CommandHandlerWithArg<TArg, TOpts> = (
  arg: TArg,
  opts: TOpts,
) => CommandResult | Promise<CommandResult>;

/**
 * Same as `mountResultCommand` but for commands that take exactly one
 * positional argument (e.g. `plugin add <package>`). Commander passes
 * the positional arg before the parsed opts.
 */
export function mountResultCommandWithArg<TArg, TOpts>(
  cmd: Command,
  handler: CommandHandlerWithArg<TArg, TOpts>,
  opts: MountResultCommandOptions<TOpts>,
): void {
  cmd.action(async (arg: TArg, parsedOpts: TOpts) => {
    const result = await handler(arg, parsedOpts);
    await emit(result, opts, parsedOpts);
  });
}

async function emit<TOpts>(
  result: CommandResult,
  opts: MountResultCommandOptions<TOpts>,
  parsedOpts: TOpts,
): Promise<void> {
  await emitCommandResult(result, {
    render: opts.ctx.render,
    jsonRequested: opts.jsonFlag?.(parsedOpts) ?? false,
  });
}

/**
 * The shared `command-result` dispatch seam, extracted so the declarative
 * `mountCommandSpec` (the `output: 'command-result'` arm of `dispatchOutput`) and
 * the imperative `mountResultCommand` route a `CommandResult` through ONE point
 * instead of duplicating the json-short-circuit / `render` decision.
 *
 * launch (§5.5): the result is wrapped in a `CommandOutcome` (`.data`, or
 * `.errors` for an `ErrorResult`) and serialized through the single
 * `renderOutcome` seam. `--json` emits the whole outcome; human mode renders the
 * inner result through the supplied renderer — byte-identical to the prior human
 * output. Machine consumers must never see ANSI escapes, so the JSON path never
 * renders.
 */
export async function emitCommandResult(
  result: CommandResult,
  opts: {
    readonly render: (result: CommandResult) => Promise<void>;
    readonly jsonRequested: boolean;
  },
): Promise<void> {
  await renderOutcome(outcomeFromResult(result, 0), {
    jsonRequested: opts.jsonRequested,
    render: opts.render,
  });
}
