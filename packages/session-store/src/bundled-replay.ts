/**
 * Build an in-host replay resolver from a tool registry (ADR-0084).
 *
 * The bundled (first-party, in-host) counterpart of the CLI
 * `SessionReplayRegistry`: it reads each tool's `sessionReplay` contribution via
 * the core `resolveToolHooks` hook resolver and exposes a `tool id → replay`
 * lookup. `@opensip-cli/mcp` runs only bundled tools, so this in-host resolver is
 * the correct (and only) replay path it needs — it carries NONE of the external
 * worker-isolation machinery that lives in `cli` (that concern is genuinely
 * CLI-owned and stays there).
 */

import { resolveToolHooks } from '@opensip-cli/core';

import type { SessionReplayFn } from './replay-session.js';
import type { CommandResult, ToolSessionReplay } from '@opensip-cli/contracts';
import type { ToolRegistry, ToolShortId } from '@opensip-cli/core';

/**
 * Map each tool that contributes `sessionReplay` to its in-host replay closure.
 * Returns a `tool id → SessionReplayFn | undefined` resolver suitable for
 * {@link resolveAndReplaySession}'s `replayFor`.
 */
export function bundledReplayResolver(
  tools: ToolRegistry,
): (tool: ToolShortId) => SessionReplayFn | undefined {
  const byTool = new Map<ToolShortId, SessionReplayFn>();
  for (const tool of tools.list()) {
    const contribution = resolveToolHooks(tool).sessionReplay;
    if (contribution === undefined) continue;
    byTool.set(
      contribution.tool,
      (stored) =>
        contribution.replaySession(stored) as
          | ToolSessionReplay<CommandResult>
          | Promise<ToolSessionReplay<CommandResult>>,
    );
  }
  return (tool) => byTool.get(tool);
}
