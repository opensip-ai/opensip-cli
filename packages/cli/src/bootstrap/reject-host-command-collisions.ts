import { logger, type CommandSpec, type Tool, type ToolRegistry } from '@opensip-cli/core';

import { BUILT_IN_AUDIT_SUITE_NAME } from '../commands/suite/built-in-suites.js';

const HOST_RESERVED_TOOL_ROOT_COMMANDS = new Set<string>([BUILT_IN_AUDIT_SUITE_NAME]);

/** True when a Tool spec would claim a host-reserved root command or one of its children. */
export function isHostReservedToolCommandSpec(
  spec: Pick<CommandSpec<unknown, unknown>, 'aliases' | 'name' | 'parent'>,
): boolean {
  if (spec.parent !== undefined) return HOST_RESERVED_TOOL_ROOT_COMMANDS.has(spec.parent);
  return (
    HOST_RESERVED_TOOL_ROOT_COMMANDS.has(spec.name) ||
    (spec.aliases ?? []).some((alias) => HOST_RESERVED_TOOL_ROOT_COMMANDS.has(alias))
  );
}

function collidesWithHost(tool: Tool): boolean {
  return (tool.commandSpecs ?? []).some(isHostReservedToolCommandSpec);
}

/**
 * Remove admitted Tools whose declarative surface attempts to claim a reserved
 * host root. The host command remains canonical; unrelated Tools remain loaded.
 */
export function rejectHostCommandCollisions(registry: ToolRegistry): readonly string[] {
  const rejected: string[] = [];
  for (const tool of registry.list()) {
    if (!collidesWithHost(tool)) continue;
    const name = tool.metadata.name ?? tool.metadata.id;
    if (!registry.remove(name)) continue;
    rejected.push(name);
    logger.warn({
      evt: 'cli.tool.host_command_collision',
      module: 'cli:bootstrap',
      toolId: tool.metadata.id,
      toolName: name,
      reservedCommand: BUILT_IN_AUDIT_SUITE_NAME,
      msg: `Tool '${name}' was rejected because it declares the host-reserved '${BUILT_IN_AUDIT_SUITE_NAME}' command.`,
    });
  }
  return rejected;
}
