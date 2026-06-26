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

import {
  applyCommonFlags,
  mapToolErrorToExitCode,
  type CliProgram,
  type CommandResult,
} from '@opensip-cli/contracts';
import {
  ToolError,
  currentScope,
  type LiveViewContext,
  type ReportFailureDetail,
  type ToolRunCompletion,
  type ToolRunSessions,
  type CommandSpec,
  type ToolCliContext,
} from '@opensip-cli/core';

import { type RunActionHooks } from '../bootstrap/run-plane.js';

import { showInternalCommands } from './internal-command-visibility.js';
import { splitActionArgs } from './mount-command-action.js';
import { buildOption, formatArgUsage } from './mount-command-spec-wiring.js';
import { emitCommandResult } from './mount-result-command.js';

/**
 * A {@link CommandSpec} whose handler receives the concrete host
 * {@link ToolCliContext} (render/envelope/live-view emitters), not the kernel's
 * unconstrained {@link CommandContext} marker. The host mounts THIS shape — the
 * mounter is the only place that knows the real context type, so it pins it
 * here. Tools author specs with `defineCommand<TOpts, ToolCliContext>(...)`.
 */
export type HostCommandSpec<TOpts = Record<string, unknown>> = CommandSpec<TOpts, ToolCliContext>;

/**
 * The minimal context surface {@link mountCommandSpec} / {@link dispatchOutput}
 * actually touch — the mount layer's structural dependency, decoupled from the
 * full handler-facing context.
 *
 * `render` + `setExitCode` are used by EVERY command (the `command-result`
 * dispatch arm and the thrown-`ToolError` exit-code path). `emitEnvelope` /
 * `renderLive` are used ONLY by the `signal-envelope` / `live-view` arms, so
 * they are optional here: a context that mounts only `command-result` /
 * `raw-stream` commands (the CLI-owned HOST commands) need not provide them.
 * `dispatchOutput` guards those arms and throws if the mode is requested without
 * the corresponding emitter — a mis-declared host spec fails loudly rather than
 * silently no-op'ing.
 *
 * `ToolCliContext` (which provides all four as required members) is structurally
 * assignable to this — so the existing tool-mount call sites pass unchanged. The
 * generic `mountCommandSpec` lets host commands mount with a leaner context
 * (`CliCommandsContext`) through the SAME plane, satisfying the launch "one
 * command surface" invariant (no two-tier privilege).
 */
export interface CommandMountContext extends RunActionHooks {
  readonly render: (result: CommandResult) => Promise<void>;
  readonly setExitCode: (code: number) => void;
  /** Host-owned command-failure fan-out (Plan 06). Optional on lean host contexts. */
  readonly reportFailure?: (detail: ReportFailureDetail) => Promise<void>;
  readonly emitEnvelope?: (envelope: unknown) => void;
  /**
   * Optional live view dispatch. When the command declares output:'live-view',
   * the host calls this with an optional third argument carrying the LiveViewContext
   * (with the host runSession). The impl (registry) forwards it as the second
   * arg to the registered renderer fn.
   */
  readonly renderLive?: (
    key: string,
    args: unknown,
    liveContext?: LiveViewContext,
  ) => Promise<ToolRunCompletion | void>;
}

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
 * @param ctx     The per-invocation host context (render/envelope/live-view
 *                emitters, exit-code setter) — today's `ToolCliContext`.
 * @returns       The mounted Commander command, so a caller nesting children
 *                (e.g. `mountOneTool`) can mount sub-subcommands onto it.
 */
export function mountCommandSpec<TCtx extends CommandMountContext>(
  program: CliProgram,
  spec: CommandSpec<unknown, TCtx>,
  ctx: TCtx,
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
    // Lifecycle diagnostics (§5.10): bracket the handler with `execute` events so
    // every CommandOutcome carries a record that this command ran. Scope-bound via
    // the pre-action hook's enterScope; a no-op when no scope is present (tests).
    const diagnostics = currentScope()?.diagnostics;
    diagnostics?.event('execute', 'debug', `command '${spec.name}' started`);
    // Host run lifecycle (host-owned-run-timing): mark the start boundary at the
    // command-action entry — after RunScope is entered, before the tool handler
    // runs. No-op for host commands whose leaner context carries no run plane.
    ctx.beginRun?.();
    try {
      // ADR-0054 out-of-process dispatch: for an EXTERNAL-provenance tool the
      // host forks a worker that imports the untrusted runtime and runs the
      // handler, instead of importing + invoking it in-process. The hook (bound
      // per-tool by `mountOneTool`) returns `true` when it dispatched — the
      // action then skips the in-process handler + output dispatch entirely (the
      // hook already replayed the worker's result through the host seams).
      // Bundled tools (and host commands with no hook) fall through to the
      // in-process path below, byte-identical to before.
      const dispatched = await ctx.maybeDispatchExternal?.(spec.name, optsWithArgs, positionals);
      if (dispatched === true) {
        diagnostics?.event('execute', 'debug', `command '${spec.name}' dispatched out-of-process`);
        return;
      }
      const result = await spec.handler(optsWithArgs, ctx);
      diagnostics?.event('execute', 'debug', `command '${spec.name}' completed`);
      // Static-path completion: if the handler returned a ToolRunCompletion with
      // a session contribution, the host freezes the lifecycle and persists it.
      // A plain CommandResult (no session) is a no-op — there is no tool-side
      // generic-session writer. The live-view path persists after renderLive.
      ctx.completeRun?.(result);
      await dispatchOutput(result, spec, optsWithArgs, positionals, ctx);
    } catch (error) {
      if (error instanceof ToolError) {
        if (ctx.reportFailure !== undefined) {
          await ctx.reportFailure({
            error,
            jsonRequested: (optsWithArgs as Record<string, unknown>).json === true,
          });
          return;
        }
        ctx.setExitCode(mapToolErrorToExitCode(error));
        return;
      }
      throw error;
    }
  });
  return cmd;
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
 *   - `raw-stream`      — explicit raw output (no Ink): the handler already
 *                         wrote its file + line; the host renders nothing.
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
      await emitCommandResult(result as CommandResult, {
        render: (r) => ctx.render(r),
        jsonRequested,
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
        await ctx.render(result as CommandResult);
      }
      return;
    }
    case 'raw-stream': {
      // The handler is responsible for its own stdout / file IO (a documented
      // exception: completion scripts, baseline/SARIF exports). Nothing to
      // render — the host does not touch the stream.
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
      const liveContext: LiveViewContext | undefined = (
        ctx as unknown as { runSession?: ToolRunSessions }
      ).runSession
        ? {
            runSession: (ctx as unknown as { runSession: ToolRunSessions }).runSession,
          }
        : undefined;
      await ctx.renderLive(spec.name, { ...opts, _args: positionals }, liveContext);
      return;
    }
  }
}
