import { type CliProgram } from '@opensip-cli/contracts';
import {
  CLI_DIAGNOSTIC_CODES,
  logger,
  PluginIncompatibleError,
  type Tool,
  type ToolCliContext,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import { mountCommandSpec } from '../commands/mount-command-spec.js';

import { buildMaybeDispatchExternal } from './bind-external-dispatch.js';
import { bindToolCliContext } from './bind-tool-context.js';
import { getBootstrapDiagnosticsBuffer } from './bootstrap-diagnostics-buffer.js';
import { BOOTSTRAP_MODULE } from './constants.js';
import { decorateToolPrimary } from './decorate-tool-primary.js';
import { type RunActionHooks } from './run-plane.js';
import { provenanceSourceFor } from './tool-provenance.js';

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
 * Mount failures are **bundled fail-closed, external best-effort** (R16). A
 * bundled tool whose spec fails to mount throws `PluginIncompatibleError` so the
 * composition root aborts startup (exit 5). External provenance (installed /
 * project-local / user-global) keeps the warn-and-continue posture.
 *
 * @param registry The per-invocation tool registry to walk.
 * @param program The root Commander program (host-owned; the composition root
 *   passes it — it is no longer reachable through the tool context, §8).
 * @param ctx The per-invocation handler context (render/emit/scope — no program).
 * @param provenance Admitted-tool provenance from bootstrap (required — no default).
 * @throws {PluginIncompatibleError} When a bundled tool's command surface fails to mount.
 */
export function mountAllToolCommands(
  registry: ToolRegistry,
  program: CliProgram,
  ctx: ToolCliContext,
  provenance: readonly ToolProvenance[],
  runActionHooks: RunActionHooks,
): void {
  for (const tool of registry.list()) {
    try {
      mountOneTool(program, tool, ctx, runActionHooks);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const human = tool.metadata.name ?? tool.metadata.id;
      getBootstrapDiagnosticsBuffer().record({
        severity: 'warning',
        code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_LOAD_FAILED,
        category: 'discovery',
        message: `Tool ${human} failed to mount: ${msg}`,
        impact: 'The tool commands are not available on the CLI surface.',
        provenance: {
          toolId: tool.metadata.id,
          packageName: human,
          discoverySource: 'mount',
        },
        detail: msg,
      });
      if (provenanceSourceFor(tool, provenance) === 'bundled') {
        logger.warn({
          evt: 'cli.tool.bundled_mount_failed',
          module: BOOTSTRAP_MODULE,
          toolId: tool.metadata.id,
          toolName: human,
          error: msg,
        });
        throw new PluginIncompatibleError(`bundled tool '${human}' failed to mount: ${msg}`, {
          diagnostic: 'bundled command surface mount failed',
        });
      }
      logger.warn({
        evt: 'cli.tool.register_failed',
        module: BOOTSTRAP_MODULE,
        toolId: tool.metadata.id, // stable UUID
        toolName: human,
        error: msg,
      });
    }
  }
  // Tier-3 internal commands are hidden from `--help` self-enforced AT MOUNT by
  // `mountCommandSpec` (it sets Commander's `_hidden` when a spec declares
  // `visibility: 'internal'` and `OPENSIP_CLI_SHOW_INTERNAL` is not set). Doing it
  // in the single mount plane — rather than a post-mount registry walk here — is
  // order-independent: it covers tool workers AND host-mounted internal commands
  // (the ADR-0054 M4-E `__tool-command-worker`, mounted later by
  // `registerCliCommands`) without depending on mount order. `internalCommandNames`
  // remains the descriptor-driven set the completion inventory filters on.
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
export function mountOneTool(
  program: CliProgram,
  tool: Tool,
  ctx: ToolCliContext,
  runActionHooks: RunActionHooks,
): void {
  if (tool.commandSpecs === undefined || tool.commandSpecs.length === 0) {
    // No declarative command surface — a mis-declared tool contributes no
    // commands. Surface it rather than silently mounting nothing.
    logger.warn({
      evt: 'cli.tool.no_command_surface',
      module: BOOTSTRAP_MODULE,
      toolId: tool.metadata.id, // stable
      toolName: tool.metadata.name ?? tool.metadata.id,
      detail: 'tool declares no commandSpecs; no commands mounted',
    });
    return;
  }

  // ADR-0054: the bound per-tool context carries the out-of-process dispatch
  // hook. The action body calls `maybeDispatchExternal`; for an external-
  // provenance tool it forks a worker (importing the untrusted runtime there)
  // instead of running the handler in-host, then replays the worker's result
  // through the SAME bound (tool-scoped) seams. Bundled tools fall through to
  // the in-process path. Merged here so host commands (lean context) never
  // carry it.
  const boundCtx = bindToolCliContext(tool, ctx);
  const toolHooks: RunActionHooks = {
    ...runActionHooks,
    maybeDispatchExternal: buildMaybeDispatchExternal(tool, boundCtx),
  };
  const mountedByName = mountFlatSpecs(program, tool, boundCtx, toolHooks);

  // Host-owned uniform decoration of the tool PRIMARY (the flat run command
  // whose name === metadata.name): per-tool `--version`, guaranteed
  // `--cwd`/`--json`/`--config`, and `--quiet`/`--verbose`. Applied ONCE here
  // in the mount layer (not re-declared per tool) and ONLY to the primary —
  // never the nested `<tool> <verb>` children or Tier-3 workers. A tool that
  // declares no primary (its name doesn't match a flat spec) gets no
  // decoration, exactly as before.
  const primaryCmd = mountedByName.get(tool.metadata.name);
  if (primaryCmd !== undefined) decorateToolPrimary(primaryCmd, tool);

  mountNestedSpecs(program, tool, boundCtx, toolHooks, mountedByName);
}

/**
 * First pass: mount every flat (no-`parent`) spec onto the root program,
 * recording each mounted command by name so nested children can resolve their
 * declared parent. `Tool.commandSpecs` is `CommandSpec<unknown, ToolCliContext>[]`,
 * which is assignable to the mounter's `HostCommandSpec` (handler contravariance).
 */
function mountFlatSpecs(
  program: CliProgram,
  tool: Tool,
  toolCtx: ToolCliContext,
  hooks: RunActionHooks,
): Map<string, CliProgram> {
  const mountedByName = new Map<string, CliProgram>();
  for (const spec of tool.commandSpecs ?? []) {
    if (spec.parent !== undefined) continue;
    mountedByName.set(spec.name, mountCommandSpec(program, spec, toolCtx, hooks));
  }
  return mountedByName;
}

/**
 * Second pass: mount each `parent`-nested spec onto its parent's mounted command
 * (the `<tool> <verb>` grammar). A spec whose declared parent was not mounted in
 * this tool is surfaced loudly (and mounted flat at root) rather than silently
 * dropped.
 */
function mountNestedSpecs(
  program: CliProgram,
  tool: Tool,
  toolCtx: ToolCliContext,
  hooks: RunActionHooks,
  mountedByName: ReadonlyMap<string, CliProgram>,
): void {
  for (const spec of tool.commandSpecs ?? []) {
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
      mountCommandSpec(program, spec, toolCtx, hooks);
      continue;
    }
    mountCommandSpec(parentCmd, spec, toolCtx, hooks);
  }
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
