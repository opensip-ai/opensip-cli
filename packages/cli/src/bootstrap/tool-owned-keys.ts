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

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import { isReservedHostPlaneIdentity } from './host-plane-state.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const HOST_IDENTITY_RESERVED = hostErrorCatalog.require('PLUGIN.HOST_IDENTITY.RESERVED');

function primaryCommandName(tool: Tool): string | undefined {
  const commands = resolveToolCommands(tool);
  const identityName = tool.identity?.name ?? tool.metadata.name;
  const primary = commands.find(
    (command) => command.parent === undefined && command.name === identityName,
  );
  if (primary !== undefined) return primary.name;

  // Legacy Tools may predate `identity` and use a human metadata name that is
  // distinct from their one flat command. Keep that compatibility without ever
  // treating a nested child (or simply array element zero) as an owned identity.
  return commands.find((command) => command.parent === undefined)?.name;
}

interface OwnedKeyCandidate {
  readonly field: string;
  readonly value: string;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '';
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
    { field: 'metadata.id', value: asNonEmptyString(tool.metadata.id) },
    { field: 'metadata.name', value: asNonEmptyString(tool.metadata.name) },
    {
      field: 'primaryCommand',
      value: asNonEmptyString(primaryCommandName(tool)),
    },
    {
      field: 'identity.layoutKey',
      value: asNonEmptyString(identity?.layoutKey),
    },
    {
      field: 'sessionReplay.tool',
      value: asNonEmptyString(hooks.sessionReplay?.tool),
    },
    {
      field: 'config.namespace',
      value: asNonEmptyString(hooks.config?.namespace),
    },
  ];
  for (const alias of identity?.aliases ?? []) {
    candidates.push({
      field: 'identity.aliases',
      value: asNonEmptyString(alias),
    });
  }

  const present = candidates.filter((c) => c.value.length > 0);

  for (const candidate of present) {
    if (isReservedHostPlaneIdentity(candidate.value)) {
      throw new PluginIncompatibleError(
        `tool '${tool.metadata.name || tool.metadata.id}' claims reserved host-plane identity via ${candidate.field}`,
        {
          code: HOST_IDENTITY_RESERVED.code,
          definition: HOST_IDENTITY_RESERVED,
          metadata: { condition: 'host-plane' },
          diagnostic: `reserved host-plane identity on ${candidate.field}`,
        },
      );
    }
  }

  return new Set(present.map((c) => c.value));
}
