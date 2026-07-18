/**
 * mount-command-spec — the host-owned layer that turns a declarative
 * {@link CommandSpec} (core, Phase 0) into a wired Commander command.
 *
 * Generalizes {@link mountResultCommand}: it mounts ANY command (tool or host)
 * from its typed spec — translating each `OptionSpec`/`ArgSpec` into Commander
 * wiring, applying the shared common flags (ADR-0021), and owning the uniform
 * `parse → handler → dispatch output → map error → exit` pipeline. Tools never
 * touch Commander; they export specs and the host mounts them (north-star §5.4).
 *
 * The single output-dispatch seam — {@link dispatchOutput} — wraps every machine
 * output in a `CommandOutcome` serialized through the one `renderOutcome` seam.
 * The wrap lives in the host emit seams this delegates to (`emitCommandResult`,
 * `ctx.emitEnvelope`), so the handler contract stayed byte-identical (§5.5).
 */

import { applyCommonFlags, type CliProgram } from '@opensip-cli/contracts';
import { type CommandMountContext, type CommandSpec, type ToolCliContext } from '@opensip-cli/core';

import { type RunActionHooks } from '../bootstrap/run-plane.js';

export type { CommandMountContext } from '@opensip-cli/core';

import { showInternalCommands } from './internal-command-visibility.js';
import { splitActionArgs } from './mount-command-action.js';
import { buildOption, formatArgUsage } from './mount-command-spec-wiring.js';
import { runCommandSpecAction } from './run-command-spec-action.js';

import type { CliCommandsContext } from './shared.js';
import type { CommandActionScopeRunner } from '../bootstrap/command-action-scope-runner.js';

/**
 * A {@link CommandSpec} whose handler receives the concrete host
 * {@link ToolCliContext} (render/envelope/live-view emitters), not the kernel's
 * unconstrained {@link CommandContext} marker. The host mounts THIS shape — the
 * mounter is the only place that knows the real context type, so it pins it
 * here. Tools author specs with `defineCommand<TOpts, ToolCliContext>(...)`.
 */
export type HostCommandSpec<TOpts = Record<string, unknown>> = CommandSpec<TOpts, ToolCliContext>;

/**
 * Mount a declarative {@link CommandSpec} onto `program` as a fully wired
 * Commander command.
 *
 * Steps (mirroring each tool's former hand-rolled `register()` body, now
 * host-owned and uniform):
 *   1. `program.command(name)` + description + aliases.
 *   2. `applyCommonFlags(cmd, spec.commonFlags)` — the ADR-0021 registry flags.
 *      `cwd` (the only computed default) is seeded with `process.cwd()`.
 *   3. Each {@link OptionSpec} → a Commander `Option` (value vs boolean,
 *      `negatable` `--no-` form, `default` / `arrayDefault`, `choices`,
 *      `parse` argParser, `variadic`, `required` mandatory).
 *   4. Each {@link ArgSpec} → `cmd.argument(...)` (variadic / optional bracketing).
 *   5. `cmd.action(...)` → run `spec.handler(opts, ctx)` → {@link dispatchOutput}
 *      → on a thrown {@link ToolError}, `mapToolErrorToExitCode` → `ctx.setExitCode`.
 *
 * @param program The Commander program to mount onto — the root `CliProgram`
 *                for a flat command, or a parent command (a host subcommand
 *                group, or a tool's primary command for a `CommandSpec.parent`
 *                nested child) when nesting. `program.command(...)` mounts onto
 *                whatever object it is called on, so nesting is purely a matter
 *                of which program is passed.
 * @param spec    The declarative command surface the tool/host exported.
 * @param ctx     The per-invocation mount context (render/envelope/live-view
 *                emitters, exit-code setter). Tool handlers may receive a wider
 *                `ToolCliContext`; this is the mount plane's structural subset.
 * @param hooks   Host-only run-lifecycle hooks (`beginRun`, `completeRun`, …).
 *                Omitted for lean host-command contexts that carry no run plane.
 * @param actionScopeRunner Invocation-local bridge that binds the RunScope
 *                across Commander's async pre-action/action continuation.
 * @returns       The mounted Commander command, so a caller nesting children
 *                (e.g. `mountOneTool`) can mount sub-subcommands onto it.
 */
export function mountCommandSpec(
  program: CliProgram,
  spec: CommandSpec<unknown, CliCommandsContext>,
  ctx: CliCommandsContext,
  hooks?: RunActionHooks,
  actionScopeRunner?: CommandActionScopeRunner,
): CliProgram;
export function mountCommandSpec(
  program: CliProgram,
  spec: CommandSpec<unknown, ToolCliContext>,
  ctx: ToolCliContext,
  hooks?: RunActionHooks,
  actionScopeRunner?: CommandActionScopeRunner,
): CliProgram;
export function mountCommandSpec<TCtx extends CommandMountContext>(
  program: CliProgram,
  spec: CommandSpec<unknown, TCtx>,
  ctx: TCtx,
  hooks: RunActionHooks = {},
  actionScopeRunner?: CommandActionScopeRunner,
): CliProgram {
  const cmd = program.command(spec.name).description(spec.description);
  if (spec.aliases !== undefined && spec.aliases.length > 0) {
    cmd.aliases([...spec.aliases]);
  }

  // Tier-3 visibility, self-enforced AT MOUNT (tool-command-surface-taxonomy).
  // A `visibility: 'internal'` command (every Tier-3 worker — fit/graph/sim run
  // workers and the ADR-0054 M4-E `__tool-command-worker` dispatch worker) is
  // hidden from `--help` here, in the ONE plane that mounts every tool AND host
  // command, so hiding is order-independent: it does not matter whether the
  // command is mounted before or after any registry-walk pass. (The former
  // separate post-mount hide pass was order-dependent — it ran inside
  // `mountAllToolCommands`, BEFORE the host mounted `__tool-command-worker`, so a
  // host-mounted internal command leaked into `--help`.) The command stays fully
  // invocable (Commander only filters `_hidden` from help); `OPENSIP_CLI_SHOW_INTERNAL=1`
  // reveals it. `internalCommandNames` remains the descriptor-driven source the
  // completion inventory reads, kept in lockstep with this predicate.
  if (spec.visibility === 'internal' && !showInternalCommands()) {
    // `_hidden` is Commander-internal (the property its help renderer filters
    // on), not on the public `Command` type — set via a narrow structural cast.
    (cmd as unknown as { _hidden: boolean })._hidden = true;
  }

  // ADR-0021 common flags. `cwd` is the only flag with a computed (per-
  // invocation) default; the registry leaves it to the caller, so seed it here.
  const seedsCwd = spec.commonFlags.includes('cwd');
  applyCommonFlags(cmd, spec.commonFlags, seedsCwd ? { cwd: process.cwd() } : undefined);

  for (const optionSpec of spec.options ?? []) {
    cmd.addOption(buildOption(optionSpec, spec.name));
  }

  for (const argSpec of spec.args ?? []) {
    cmd.argument(formatArgUsage(argSpec), argSpec.description);
  }

  // Action body: parse → handler → dispatch → map error → exit. Commander
  // passes positional args first, then the parsed-opts object, then the
  // Command. We forward the parsed opts (which carry both common + spec flags)
  // and the trailing positional args to the handler and the dispatch seam.
  //
  // Positionals ride on the opts object under the `_args` key — the same
  // convention the `live-view` dispatch arm already uses (`{ ...opts, _args }`).
  // This lets a `raw-stream`/`signal-envelope`/`command-result` handler that
  // declares `args` read its positionals (`opts._args`) without a separate
  // handler-arity contract: graph's `[paths...]`, `<name>`, `<specPath>` all
  // flow through here. Commands with no declared `args` get an empty array.
  cmd.action(async (...actionArgs: unknown[]) => {
    const { opts, positionals } = splitActionArgs(actionArgs);
    const optsWithArgs = { ...opts, _args: positionals };
    const runAction = () => runCommandSpecAction(spec, optsWithArgs, positionals, ctx, hooks);
    if (actionScopeRunner === undefined) {
      await runAction();
      return;
    }
    await actionScopeRunner.run(runAction);
  });
  return cmd;
}

export { dispatchOutput, runCommandSpecAction } from './run-command-spec-action.js';
