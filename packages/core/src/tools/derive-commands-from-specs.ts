/**
 * Derive {@link ToolCommandDescriptor} rows from declarative {@link CommandSpec}s.
 *
 * Single source for command identity on the runtime Tool: authors maintain
 * `commandSpecs` (+ the static package.json manifest); the host derives
 * `commands[]` via {@link defineTool} or {@link resolveToolCommands}.
 */

import type { CommandSpec } from './command-spec.js';
import type { ToolCliContext, Tool, ToolCommandDescriptor } from './types.js';

/** Map each mounted spec to the descriptor shape the registry and help plane consume. */
export function deriveCommandsFromSpecs(
  specs: readonly CommandSpec<unknown, ToolCliContext>[],
): ToolCommandDescriptor[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
    ...(spec.scope === undefined ? {} : { scope: spec.scope }),
  }));
}

/**
 * Resolve the authoritative command descriptors for a tool.
 *
 * Prefers an explicit `commands[]` when present (legacy / hand-authored tools).
 * Otherwise derives from `commandSpecs`. Empty when neither is available.
 */
export function resolveToolCommands(tool: Tool): readonly ToolCommandDescriptor[] {
  if (tool.commands.length > 0) {
    return tool.commands;
  }
  if (tool.commandSpecs !== undefined && tool.commandSpecs.length > 0) {
    return deriveCommandsFromSpecs(tool.commandSpecs);
  }
  return [];
}

/** Canonical command names for manifest drift checks and owning-tool resolution. */
export function resolveToolCommandNames(tool: Tool): readonly string[] {
  return resolveToolCommands(tool).map((c) => c.name);
}
