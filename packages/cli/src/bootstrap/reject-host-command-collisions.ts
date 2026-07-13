import { logger, type CommandSpec, type Tool, type ToolRegistry } from '@opensip-cli/core';

import { HOST_RESERVED_ROOT_COMMANDS } from './reserved-names.js';

/** The host-reserved name a spec claims (root name, root alias, or parent), if any. */
function reservedNameClaimedBySpec(
  spec: Pick<CommandSpec<unknown, unknown>, 'aliases' | 'name' | 'parent'>,
): string | undefined {
  if (spec.parent !== undefined) {
    return HOST_RESERVED_ROOT_COMMANDS.has(spec.parent) ? spec.parent : undefined;
  }
  if (HOST_RESERVED_ROOT_COMMANDS.has(spec.name)) return spec.name;
  return (spec.aliases ?? []).find((alias) => HOST_RESERVED_ROOT_COMMANDS.has(alias));
}

function reservedCollision(tool: Tool): string | undefined {
  for (const spec of tool.commandSpecs ?? []) {
    const reserved = reservedNameClaimedBySpec(spec);
    if (reserved !== undefined) return reserved;
  }
  return undefined;
}

/**
 * Remove admitted Tools whose declarative surface attempts to claim a reserved
 * host root (ADR-0159: the full host command surface, not just `audit`). The
 * host command remains canonical; unrelated Tools remain loaded.
 */
export function rejectHostCommandCollisions(registry: ToolRegistry): readonly string[] {
  const rejected: string[] = [];
  for (const tool of registry.list()) {
    const reservedCommand = reservedCollision(tool);
    if (reservedCommand === undefined) continue;
    const name = tool.metadata.name ?? tool.metadata.id;
    if (!registry.remove(name)) continue;
    rejected.push(name);
    logger.warn({
      evt: 'cli.tool.host_command_collision',
      module: 'cli:bootstrap',
      toolId: tool.metadata.id,
      toolName: name,
      reservedCommand,
      msg: `Tool '${name}' was rejected because it declares the host-reserved '${reservedCommand}' command.`,
    });
  }
  return rejected;
}
