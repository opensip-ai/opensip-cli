/**
 * mount-command-spec — the host-owned layer that turns a declarative
 * {@link CommandSpec} (core, Phase 0) into a wired Commander command.
 *
 * This is the generalization of {@link mountResultCommand}: where that helper
 * mounts a single CLI-owned `CommandResult` action body, `mountCommandSpec`
 * mounts ANY command (tool or host) from its typed spec — translating each
 * declared `OptionSpec`/`ArgSpec` into Commander wiring, applying the shared
 * common flags (ADR-0021), and owning the uniform
 *
 *     parse → handler → dispatch output → map error → exit
 *
 * pipeline. Tools never touch Commander; they export specs and the host mounts
 * them (launch, north-star §5.4 Command contract).
 *
 * The single output-dispatch seam — {@link dispatchOutput} — was the **launch
 * `CommandOutcome` hinge**, now landed: every machine output is wrapped in a
 * `CommandOutcome` and serialized through the one `renderOutcome` seam. The wrap
 * lives in the host emit seams this function delegates to (`emitCommandResult`,
 * `ctx.emitEnvelope`), so the handler contract and the mounter stayed
 * byte-identical — all the outer-shape change landed in those seams (release
 * launch, north-star §5.5).
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
  type ToolRunCompletion,
  type ToolRunSessions,
  type ArgSpec,
  type CommandSpec,
  type OptionSpec,
  type ToolCliContext,
} from '@opensip-cli/core';
import { Option } from 'commander';

import { type RunActionHooks } from '../bootstrap/run-plane.js';

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
export interface CommandMountContext {
  readonly render: (result: CommandResult) => Promise<void>;
  readonly setExitCode: (code: number) => void;
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
 * @param program The root Commander program (the entry layer's `CliProgram`).
 * @param spec    The declarative command surface the tool/host exported.
 * @param ctx     The per-invocation host context (render/envelope/live-view
 *                emitters, exit-code setter) — today's `ToolCliContext`.
 */
export function mountCommandSpec<TCtx extends CommandMountContext>(
  program: CliProgram,
  spec: CommandSpec<unknown, TCtx>,
  ctx: TCtx,
): void {
  const cmd = program.command(spec.name).description(spec.description);
  if (spec.aliases !== undefined && spec.aliases.length > 0) {
    cmd.aliases([...spec.aliases]);
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
    // runs. The hooks ride on the host ctx (not the public ToolCliContext type);
    // read via cast, like `runSession` below. No-op for host commands whose
    // leaner context carries no run plane.
    const runHooks = ctx as unknown as RunActionHooks;
    runHooks.beginRun?.();
    try {
      const result = await spec.handler(optsWithArgs, ctx);
      diagnostics?.event('execute', 'debug', `command '${spec.name}' completed`);
      // Static-path completion: if the handler returned a ToolRunCompletion with
      // a session contribution, the host freezes the lifecycle and persists it.
      // A plain CommandResult is a no-op (the transitional record(...) path still
      // owns persistence until Phase 3). The live-view path persists after
      // renderLive (Phase 2).
      runHooks.completeRun?.(result);
      await dispatchOutput(result, spec, optsWithArgs, positionals, ctx);
    } catch (error) {
      if (error instanceof ToolError) {
        diagnostics?.event('execute', 'error', `command '${spec.name}' failed: ${error.message}`);
        ctx.setExitCode(mapToolErrorToExitCode(error));
        return;
      }
      throw error;
    }
  });
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
        ? { runSession: (ctx as unknown as { runSession: ToolRunSessions }).runSession }
        : undefined;
      await ctx.renderLive(spec.name, { ...opts, _args: positionals }, liveContext);
      return;
    }
  }
}

/**
 * Build a Commander {@link Option} from an {@link OptionSpec}, covering every
 * shape in the first-party flag corpus: boolean / value, negatable `--no-`,
 * literal `default` and repeatable `arrayDefault`, `choices`, the pure `parse`
 * argParser, variadic, and `required` (mandatory).
 *
 * @throws {Error} When the spec marks a boolean (valueless) option `required`
 *   — only value options can be made mandatory.
 */
function buildOption(spec: OptionSpec, commandName: string): Option {
  const valuePlaceholder = resolveValuePlaceholder(spec);
  const flags = valuePlaceholder === undefined ? spec.flag : `${spec.flag} ${valuePlaceholder}`;
  const option = new Option(flags, spec.description);

  if (spec.choices !== undefined && spec.choices.length > 0) {
    option.choices([...spec.choices]);
  }
  if (spec.parse !== undefined) {
    // Commander's argParser is `(value, previous) => next` — exactly the
    // declared `OptionSpec.parse` reducer shape (Number coercion, repeatable
    // accumulation, validated ints).
    option.argParser(spec.parse);
  }
  // `arrayDefault` (repeatable accumulators) wins over a scalar `default`;
  // Commander uses it as the seed the `parse` reducer accumulates onto.
  if (spec.arrayDefault !== undefined) {
    option.default([...spec.arrayDefault]);
  } else if (spec.default !== undefined) {
    option.default(spec.default);
  }
  if (spec.required === true) {
    if (valuePlaceholder === undefined) {
      throw new Error(
        `mountCommandSpec: command '${commandName}' option '${spec.flag}' is required but takes no value; ` +
          'only value options can be required.',
      );
    }
    option.makeOptionMandatory(true);
  }
  return option;
}

/**
 * Resolve the value placeholder for an option, applying variadic `...` when
 * declared. Returns `undefined` for a boolean / negatable flag (no value).
 */
function resolveValuePlaceholder(spec: OptionSpec): string | undefined {
  if (spec.negatable === true) return undefined;
  if (spec.value === undefined) return undefined;
  if (spec.variadic === true && !spec.value.includes('...')) {
    // Inject the variadic ellipsis inside the existing bracket pair, e.g.
    // `<slug>` → `<slug...>`, `[path]` → `[path...]`.
    return spec.value.replace(/([>\]])$/, '...$1');
  }
  return spec.value;
}

/**
 * Format an {@link ArgSpec} into Commander argument-usage syntax: `<name>`
 * (required), `[name]` (optional), with `...` appended for variadic.
 */
function formatArgUsage(spec: ArgSpec): string {
  const inner = spec.variadic === true ? `${spec.name}...` : spec.name;
  return spec.optional === true ? `[${inner}]` : `<${inner}>`;
}

/**
 * Best-effort guard: does `x` look like a Commander `Command` instance?
 * Used defensively in splitActionArgs so we never treat the Command object
 * as the parsed opts (which would silently give every handler a weird
 * `opts` bag containing Commander internals and produce very confusing bugs).
 */
function isLikelyCommanderCommand(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  // Commander Command instances have these characteristic members.
  return (
    typeof c.name === 'function' ||
    typeof c.opts === 'function' ||
    typeof c.command === 'function' ||
    (typeof c.constructor === 'function' && /Command/i.test(c.constructor.name || ''))
  );
}

/**
 * Split a Commander action callback's variadic arguments into the parsed-opts
 * object and the trailing positional args.
 *
 * Commander calls `action((...positionalArgs, optsObject, command))`: the
 * declared positionals come first, then the parsed-options object, then the
 * `Command` instance. We locate the opts object by scanning left from the
 * slot before the final Command for the rightmost plain (non-array, non-Command)
 * object. Everything before that index is treated as positionals.
 *
 * This scan is robust: positionals (typically strings/paths for variadics) are
 * never inspected for "object-ness" during the search, so a defensive walk
 * cannot accidentally eat legitimate leading positionals when an intermediate
 * value looks unusual (future Commander arity change, wrappers, etc.).
 *
 * If no plausible opts object is found, we treat the entire prefix before the
 * Command as positionals and opts as {} (fail-closed paranoia below still applies).
 *
 * @throws {Error} On the defensive, normally-unreachable path where no opts object
 *   can be located among the action arguments (surfaced loudly so tests/CI catch it).
 */
function splitActionArgs(actionArgs: readonly unknown[]): {
  opts: Record<string, unknown>;
  positionals: readonly unknown[];
} {
  if (actionArgs.length === 0) {
    return { opts: {}, positionals: [] };
  }

  const lastIdx = actionArgs.length - 1;
  // The final argument is (per Commander contract) the Command instance.
  if (!isLikelyCommanderCommand(actionArgs[lastIdx])) {
    // Extremely unexpected — log via throw so tests/CI surface it loudly.
    throw new Error(
      'mountCommandSpec: splitActionArgs could not locate Commander Command as the final action argument. ' +
        'This indicates an incompatible Commander version or a wrapped dispatch. ' +
        'Please report this with your Commander version.',
    );
  }

  // Scan left from the slot immediately before the Command. The first (rightmost)
  // plain non-array non-Command object we encounter is the parsed opts.
  for (let i = lastIdx - 1; i >= 0; i--) {
    const v = actionArgs[i];
    if (v && typeof v === 'object' && !Array.isArray(v) && !isLikelyCommanderCommand(v)) {
      const opts = v as Record<string, unknown>;
      const positionals = actionArgs.slice(0, i);

      // Extra paranoia: if what we selected smells like Command, refuse.
      if (isLikelyCommanderCommand(opts)) {
        throw new Error(
          'mountCommandSpec: splitActionArgs selected a Commander Command as the parsed opts. ' +
            'Refusing to dispatch — this is a bug in argument splitting.',
        );
      }
      return { opts, positionals };
    }
  }

  // No plain opts object found before the Command (defensive). All prior args
  // become positionals; the handler will see a bare {} for opts (still better
  // than handing it a Command or corrupting _args).
  const positionals = actionArgs.slice(0, lastIdx);
  return { opts: {}, positionals };
}
