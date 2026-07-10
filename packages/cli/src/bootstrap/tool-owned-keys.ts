/**
 * tool-owned-keys — validated identity set for binder and purge (ADR-0146).
 *
 * Builds every state-capable identity a Tool may address (metadata id, human
 * name, primary command/layout key, session-replay key, config namespace) and
 * rejects any candidate that claims the reserved host-plane prefix before a
 * bound context or purge path can use it.
 */

import {
  PluginIncompatibleError,
  resolveToolCommands,
  resolveToolHooks,
  type Tool,
} from '@opensip-cli/core';

import { isReservedHostPlaneIdentity } from './host-plane-state.js';

function primaryCommandName(tool: Tool): string | undefined {
  const commands = resolveToolCommands(tool);
  return tool.commandSpecs?.[0]?.name ?? commands[0]?.name;
}

interface OwnedKeyCandidate {
  readonly field: string;
  readonly value: string;
}

/**
 * Derive the deduplicated set of ordinary tool-owned keys after rejecting any
 * reserved host-plane identity on every candidate field.
 *
 * Candidates: metadata id, human name, primary command, identity layout key,
 * identity aliases, session-replay key, and config namespace.
 *
 * @throws {PluginIncompatibleError} when any candidate begins with the reserved
 *   host-plane prefix — validation completes before any seam is callable.
 */
export function toolOwnedKeys(tool: Tool): ReadonlySet<string> {
  const hooks = resolveToolHooks(tool);
  const identity = tool.identity;
  const candidates: OwnedKeyCandidate[] = [
    { field: 'metadata.id', value: tool.metadata.id },
    { field: 'metadata.name', value: tool.metadata.name },
    { field: 'primaryCommand', value: primaryCommandName(tool) ?? '' },
    { field: 'identity.layoutKey', value: identity?.layoutKey ?? '' },
    { field: 'sessionReplay.tool', value: hooks.sessionReplay?.tool ?? '' },
    { field: 'config.namespace', value: hooks.config?.namespace ?? '' },
  ];
  for (const alias of identity?.aliases ?? []) {
    candidates.push({ field: 'identity.aliases', value: alias });
  }

  const present = candidates.filter((c): c is OwnedKeyCandidate => c.value.length > 0);

  for (const candidate of present) {
    if (isReservedHostPlaneIdentity(candidate.value)) {
      throw new PluginIncompatibleError(
        `tool '${tool.metadata.name || tool.metadata.id}' claims reserved host-plane identity via ${candidate.field}`,
        {
          code: 'PLUGIN.HOST_PLANE_IDENTITY_RESERVED',
          diagnostic: `reserved host-plane identity on ${candidate.field}`,
        },
      );
    }
  }

  return new Set(present.map((c) => c.value));
}
