import { type CliProgram } from '@opensip-cli/contracts';
import { logger, type Tool, type ToolCliContext, type ToolRegistry } from '@opensip-cli/core';

import { mountCommandSpec } from '../commands/mount-command-spec.js';

import { bindToolCliContext } from './bind-tool-context.js';
import { BOOTSTRAP_MODULE } from './constants.js';

/**
 * Walk the registry and mount each tool's commands onto `program`. This is
 * **step 8** of the tool lifecycle (launch, §5.4) — see
 * {@link runToolLifecycle}.
 *
 * Public launch: there is ONE command surface — the tool's declared `commandSpecs`,
 * mounted by `mountCommandSpec`. `register()` and the raw-Commander `program`
 * handle on the tool context are gone, so the host owns `program` and passes it
 * in here (the tool never touches Commander). A tool with no `commandSpecs` is a
 * mis-declaration: it contributes no commands, surfaced loudly via
 * `cli.tool.no_command_surface`.
 *
 * Failures are isolated per tool — one tool whose spec fails to mount must not
 * take the whole CLI down. The failure is logged + stderr-warned, then we
 * continue with the next tool.
 *
 * @param registry The per-invocation tool registry to walk.
 * @param program The root Commander program (host-owned; the composition root
 *   passes it — it is no longer reachable through the tool context, §8).
 * @param ctx The per-invocation handler context (render/emit/scope — no program).
 */
export function mountAllToolCommands(
  registry: ToolRegistry,
  program: CliProgram,
  ctx: ToolCliContext,
): void {
  for (const tool of registry.list()) {
    try {
      mountOneTool(program, tool, ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const human = tool.metadata.name ?? tool.metadata.id;
      process.stderr.write(`opensip: tool ${human} failed to mount: ${msg}\n`);
      logger.warn({
        evt: 'cli.tool.register_failed',
        module: BOOTSTRAP_MODULE,
        toolId: tool.metadata.id, // stable UUID
        toolName: human,
        error: msg,
      });
    }
  }
  // ADR-0021: one shared help shape across every mounted command — uniform
  // option/subcommand ordering and a docs footer — applied here (the single
  // place that has walked every tool's commands) rather than per tool.
  applySharedHelpConfiguration(program);
}

/**
 * Mount ONE tool's commands from its declared `commandSpecs` — the only command
 * surface (public launch). Extracted so {@link mountAllToolCommands} keeps its
 * per-tool failure isolation around a single call. A tool with no `commandSpecs`
 * contributes nothing and is surfaced via `cli.tool.no_command_surface`.
 */
function mountOneTool(program: CliProgram, tool: Tool, ctx: ToolCliContext): void {
  if (tool.commandSpecs !== undefined && tool.commandSpecs.length > 0) {
    const toolCtx = bindToolCliContext(tool, ctx);
    for (const spec of tool.commandSpecs) {
      // `Tool.commandSpecs` is `CommandSpec<unknown, ToolCliContext>[]`, which
      // is assignable to the mounter's `HostCommandSpec` (handler contravariance
      // — an `unknown`-opts handler accepts a `Record`-opts call). No cast.
      mountCommandSpec(program, spec, toolCtx);
    }
    return;
  }
  // No declarative command surface — a mis-declared tool contributes no commands.
  // Surface it rather than silently mounting nothing.
  logger.warn({
    evt: 'cli.tool.no_command_surface',
    module: BOOTSTRAP_MODULE,
    toolId: tool.metadata.id, // stable
    toolName: tool.metadata.name ?? tool.metadata.id,
    detail: 'tool declares no commandSpecs; no commands mounted',
  });
}

const DOCS_HELP_FOOTER = '\nDocs: https://opensip.ai/docs/opensip-cli';

/**
 * Apply one help configuration to the root program and every (sub)command:
 * options + subcommands sort alphabetically so the help reads the same across
 * `fit`/`graph`/`sim`, and the root help ends with a docs pointer (ADR-0021).
 */
function applySharedHelpConfiguration(program: CliProgram): void {
  const configure = (cmd: CliProgram): void => {
    cmd.configureHelp({ sortOptions: true, sortSubcommands: true });
    for (const sub of cmd.commands) configure(sub);
  };
  configure(program);
  program.addHelpText('after', DOCS_HELP_FOOTER);
}
