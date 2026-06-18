import { type CliProgram } from '@opensip-cli/contracts';
import { logger, type Tool, type ToolCliContext, type ToolRegistry } from '@opensip-cli/core';

import { mountCommandSpec } from '../commands/mount-command-spec.js';

import { bindToolCliContext } from './bind-tool-context.js';
import { BOOTSTRAP_MODULE } from './register-tools-shared.js';

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
 *
 * Nesting (`CommandSpec.parent`, tool-command-surface-taxonomy Task 0.4): a spec
 * declaring `parent` is mounted as a SUBCOMMAND of the same-tool spec whose name
 * matches `parent` (the tool's primary verb) — enabling the `<tool> <verb>`
 * grammar (`graph export`, `fit list`). This is the SAME generic parent+leaf
 * pattern the host already uses for `sessions`/`plugin`/`tools`
 * (`host-command-specs.ts:mountHostCommands`): the parent's mounted Commander
 * command (which also carries its own action) hosts the child via
 * `mountCommandSpec(primaryCmd, child, ctx)`. No per-tool special case. Specs
 * with no `parent` mount flat onto the root program exactly as before.
 */
export function mountOneTool(program: CliProgram, tool: Tool, ctx: ToolCliContext): void {
  if (tool.commandSpecs !== undefined && tool.commandSpecs.length > 0) {
    const toolCtx = bindToolCliContext(tool, ctx);

    // First pass: mount every flat (no-`parent`) spec onto the root program,
    // recording each mounted command by name so nested children can resolve
    // their declared parent. `Tool.commandSpecs` is
    // `CommandSpec<unknown, ToolCliContext>[]`, which is assignable to the
    // mounter's `HostCommandSpec` (handler contravariance) — no cast.
    const mountedByName = new Map<string, CliProgram>();
    for (const spec of tool.commandSpecs) {
      if (spec.parent !== undefined) continue;
      const cmd = mountCommandSpec(program, spec, toolCtx);
      mountedByName.set(spec.name, cmd);
    }

    // Second pass: mount each `parent`-nested spec onto its parent's mounted
    // command (the `<tool> <verb>` grammar). A spec whose declared parent was
    // not mounted in this tool is surfaced loudly rather than silently dropped.
    for (const spec of tool.commandSpecs) {
      if (spec.parent === undefined) continue;
      const parentCmd = mountedByName.get(spec.parent);
      if (parentCmd === undefined) {
        logger.warn({
          evt: 'cli.tool.unknown_command_parent',
          module: BOOTSTRAP_MODULE,
          toolId: tool.metadata.id, // stable
          toolName: tool.metadata.name ?? tool.metadata.id,
          detail: `command '${spec.name}' declares parent '${spec.parent}', which is not a flat command on this tool; mounting flat at root instead`,
        });
        mountCommandSpec(program, spec, toolCtx);
        continue;
      }
      mountCommandSpec(parentCmd, spec, toolCtx);
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
