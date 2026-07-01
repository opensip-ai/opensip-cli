/**
 * owning-tool-init — resolve the tool that owns the invoked subcommand and run
 * its lazy, once-per-process `Tool.initialize()`.
 *
 * Extracted from `pre-action-hook.ts` so that hook stays the high-level
 * per-invocation SEQUENCER; the owning-tool resolution + fail-fast init
 * semantics live here as a cohesive unit (see also `tool-lifecycle.ts`).
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  logger,
  resolveToolCommands,
  resolveToolHooks,
  type Tool,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import { BootstrapError } from './bootstrap-error.js';
import { initializedToolIds } from './process-idempotency.js';
import { shouldRunHookInHost } from './tool-provenance.js';

const MODULE_TAG = 'cli:bootstrap';

/**
 * Find the registered tool that owns the invoked command path, matching the
 * first path segment against a descriptor's canonical name or alias. Nested
 * commands such as `graph list` are owned by `graph`, never by the leaf
 * `list`. Returns undefined for
 * CLI-only commands (init/sessions/configure/plugin/...) — they belong to
 * no tool, so no `initialize()` runs for them.
 */
export function resolveOwningTool(tools: ToolRegistry, commandPath: string): Tool | undefined {
  const ownerCommand = commandPath.split(' ')[0] ?? commandPath;
  return tools
    .list()
    .find((tool) =>
      resolveToolCommands(tool).some(
        (c) => c.name === ownerCommand || (c.aliases?.includes(ownerCommand) ?? false),
      ),
    );
}

/**
 * Lazy, memoized Tool.initialize() (P1a). Resolve the tool owning the
 * invoked subcommand and run its initialize() exactly once per process,
 * after the scope is entered and immediately before the action body. Tools
 * not invoked this run pay nothing; `--help`/welcome run no initialize().
 *
 * Fail-fast: a throwing initialize() fails the run closed rather than letting a
 * half-initialised tool run its command and silently appear to work. The
 * id is recorded only on success, so a transient failure can retry in a
 * long-lived host.
 *
 * ADR-0054 M4-F: the host does NOT run an EXTERNAL owning tool's `initialize()`
 * (executing untrusted runtime in the kernel is the load-time hole the ADR
 * rejects). An external command dispatches to the worker (`maybeDispatchExternal`),
 * and the worker entry runs the dispatched tool's `initialize()` there (the
 * isolation boundary). Bundled owning tools initialize in-host exactly as before.
 *
 * @throws {BootstrapError} (exit 1) when the owning tool's initialize() throws —
 *   the top-level boundary renders it (human stderr / structured `--json`).
 */
export async function maybeInitializeOwningTool(
  tools: ToolRegistry,
  commandPath: string,
  runId: string,
  provenance: readonly ToolProvenance[] = [],
): Promise<void> {
  const owningTool = resolveOwningTool(tools, commandPath);
  if (!owningTool) return;
  // M4-F: skip an external owning tool host-side — its initialize runs worker-side.
  if (!shouldRunHookInHost(owningTool, provenance)) return;
  const hooks = resolveToolHooks(owningTool);
  if (!hooks.initialize) return;
  const toolHumanId = owningTool.metadata.name ?? owningTool.metadata.id;
  if (initializedToolIds.has(toolHumanId)) return;
  try {
    await hooks.initialize();
    initializedToolIds.add(toolHumanId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({
      evt: 'cli.tool.initialize_failed',
      module: MODULE_TAG,
      runId,
      toolId: owningTool.metadata.id, // stable UUID for structured
      toolName: toolHumanId,
      error: msg,
    });
    // §4.7: a tool-init failure becomes a typed BootstrapError (exit 1) the
    // top-level boundary renders, instead of an inline stderr write + exit.
    throw new BootstrapError({
      message: `Tool '${toolHumanId}' failed to initialize: ${msg}`,
      humanMessage: `✗ Tool '${toolHumanId}' failed to initialize: ${msg}`,
      suggestion: undefined,
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    });
  }
}
