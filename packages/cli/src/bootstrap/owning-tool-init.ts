/**
 * owning-tool-init — resolve the tool that owns the invoked subcommand and run
 * its lazy, once-per-process `Tool.initialize()`.
 *
 * Extracted from `pre-action-hook.ts` so that hook stays the high-level
 * per-invocation SEQUENCER; the owning-tool resolution + fail-fast init
 * semantics live here as a cohesive unit (see also `tool-lifecycle.ts`).
 */

import { logger, type Tool, type ToolRegistry } from '@opensip-cli/core';

import { BootstrapError } from './bootstrap-error.js';
import { initializedToolIds } from './process-idempotency.js';

const MODULE_TAG = 'cli:bootstrap';

/**
 * Find the registered tool that owns the invoked subcommand, matching the
 * descriptor's canonical name or any alias. Returns undefined for
 * CLI-only commands (init/sessions/configure/plugin/...) — they belong to
 * no tool, so no `initialize()` runs for them.
 */
export function resolveOwningTool(tools: ToolRegistry, cmdName: string): Tool | undefined {
  return tools
    .list()
    .find((tool) =>
      tool.commands.some((c) => c.name === cmdName || (c.aliases?.includes(cmdName) ?? false)),
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
 * @throws {BootstrapError} (exit 1) when the owning tool's initialize() throws —
 *   the top-level boundary renders it (human stderr / structured `--json`).
 */
export async function maybeInitializeOwningTool(
  tools: ToolRegistry,
  cmdName: string,
  runId: string,
): Promise<void> {
  const owningTool = resolveOwningTool(tools, cmdName);
  if (!owningTool?.initialize) return;
  const toolHumanId = owningTool.metadata.name ?? owningTool.metadata.id;
  if (initializedToolIds.has(toolHumanId)) return;
  try {
    await owningTool.initialize();
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
      exitCode: 1,
    });
  }
}
