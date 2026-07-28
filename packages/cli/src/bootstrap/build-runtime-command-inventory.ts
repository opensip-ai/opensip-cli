/**
 * Composition-root projector: declarative CommandSpecs → plain RuntimeCommandInventory.
 * Built once for MCP `scope.runtimeCommands` (no live handlers; MCP cannot import this module).
 */

import {
  createRuntimeCommandInventory,
  MAX_RUNTIME_COMMAND_ALIASES,
  MAX_RUNTIME_COMMAND_GROUPS,
  MAX_RUNTIME_COMMAND_LEAVES,
  MAX_RUNTIME_COMMAND_NAME,
  MAX_RUNTIME_COMMAND_PATH,
  type RuntimeCommandGroup,
  type RuntimeCommandInventory,
  type RuntimeCommandInventoryLimits,
  type RuntimeCommandLeaf,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import {
  inventoryError,
  readOwn,
  readStaticHandler,
  readString,
  readStringArray,
} from './runtime-command-spec-readers.js';

import type { HostSubcommandGroup, ToolPluginGroup } from '../commands/host-subcommand-groups.js';

const PRODUCTION_LIMITS: RuntimeCommandInventoryLimits = Object.freeze({
  maxLeaves: MAX_RUNTIME_COMMAND_LEAVES,
  maxGroups: MAX_RUNTIME_COMMAND_GROUPS,
  maxAliases: MAX_RUNTIME_COMMAND_ALIASES,
  maxName: MAX_RUNTIME_COMMAND_NAME,
  maxPath: MAX_RUNTIME_COMMAND_PATH,
});

/** Inputs for one complete host+Tool inventory projection. */
export interface BuildRuntimeCommandInventoryInput {
  readonly toolRegistry: ToolRegistry;
  /** Opaque validated command specs (Tool or host context); read via own-data only. */
  readonly toolCommandSpecs: readonly object[];
  readonly hostSpecs: readonly object[];
  readonly hostGroups: readonly HostSubcommandGroup[];
  readonly toolPluginGroups: readonly ToolPluginGroup[];
  readonly manifests?: readonly ToolPluginManifest[];
  readonly provenance?: readonly ToolProvenance[];
  /** Injected limits for unit tests; production uses core production caps. */
  readonly limits?: RuntimeCommandInventoryLimits;
}

interface ToolIdentityFacts {
  readonly canonicalName: string;
  readonly packageIdentity?: string;
  readonly provenanceSource?: string;
}

function indexToolFacts(
  registry: ToolRegistry,
  manifests: readonly ToolPluginManifest[],
  provenance: readonly ToolProvenance[],
): ReadonlyMap<string, ToolIdentityFacts> {
  const byCanonical = new Map<string, ToolIdentityFacts>();
  for (const tool of registry.values()) {
    const name = tool.identity.name;
    byCanonical.set(name, { canonicalName: name });
  }
  for (const prov of provenance) {
    const name = prov.id;
    const existing = byCanonical.get(name) ?? { canonicalName: name };
    byCanonical.set(name, {
      ...existing,
      provenanceSource: prov.source,
      ...(prov.packageName === undefined ? {} : { packageIdentity: prov.packageName }),
    });
  }
  for (const manifest of manifests) {
    const name = manifest.identity.name;
    const existing = byCanonical.get(name);
    if (existing === undefined) continue;
    if (existing.packageIdentity === undefined && typeof manifest.id === 'string') {
      // Prefer provenance packageName; manifest id is not package identity.
    }
  }
  return byCanonical;
}

function toolForCommand(
  registry: ToolRegistry,
  name: string,
  parent: string | undefined,
): Tool | undefined {
  const tools = [...registry.values()];
  if (parent !== undefined) {
    return tools.find((t) => t.identity.name === parent);
  }
  return tools.find((t) => t.identity.name === name);
}

/**
 * Project one leaf command-spec into plain inventory data (never invokes handler).
 *
 * @throws {Error} When name/output/handler is missing or staticHandler is invalid.
 */
function projectLeafFromSpec(
  spec: object,
  path: string,
  owner: RuntimeCommandLeaf['owner'],
  ownerLabel: string,
  facts?: ToolIdentityFacts,
): RuntimeCommandLeaf {
  const name = readString(spec, 'name');
  if (name === undefined) {
    inventoryError(
      `runtime inventory: command at '${path}' missing name.`,
      'command-missing-name',
      {
        path,
      },
    );
  }
  const output = readString(spec, 'output');
  if (output === undefined) {
    inventoryError(
      `runtime inventory: command '${path}' missing output.`,
      'command-missing-output',
      {
        path,
      },
    );
  }
  const scopeRaw = readString(spec, 'scope');
  const scope = scopeRaw === 'none' ? 'none' : 'project';
  const visibilityRaw = readString(spec, 'visibility');
  const visibility = visibilityRaw === 'internal' ? 'internal' : 'public';
  const aliases = readStringArray(spec, 'aliases');
  const staticHandler = readStaticHandler(spec);
  // Handler must be present as own data function for a leaf — never invoke it.
  const handlerProp = readOwn(spec, 'handler');
  if (handlerProp.kind !== 'data' || typeof handlerProp.value !== 'function') {
    inventoryError(
      `runtime inventory: command '${path}' handler missing or accessor.`,
      'command-handler-missing',
      { path },
    );
  }
  return {
    path,
    name,
    aliases,
    owner,
    ownerLabel,
    visibility,
    scope,
    output,
    ...(facts?.provenanceSource === undefined ? {} : { provenanceSource: facts.provenanceSource }),
    ...(facts?.packageIdentity === undefined ? {} : { packageIdentity: facts.packageIdentity }),
    ...(staticHandler === undefined ? {} : { staticHandler }),
  };
}

/**
 * Tool commands (flat or parent-nested) from the registry. Prefer registry tools
 * so each leaf carries admitted provenance/package identity when available.
 *
 * @throws {Error} When a tool has an invalid commandSpecs entry or leaf projection fails.
 */
function projectRegistryToolLeaves(
  toolRegistry: ToolRegistry,
  toolFacts: ReadonlyMap<string, ToolIdentityFacts>,
  leaves: RuntimeCommandLeaf[],
): void {
  for (const tool of toolRegistry.values()) {
    const canonical = tool.identity.name;
    const facts = toolFacts.get(canonical);
    const specs = tool.commandSpecs ?? [];
    for (const spec of specs) {
      if (spec === null || typeof spec !== 'object') {
        inventoryError(
          `runtime inventory: tool '${canonical}' has invalid commandSpecs entry.`,
          'tool-invalid-specs',
          { tool: canonical },
        );
      }
      const name = readString(spec, 'name');
      if (name === undefined) {
        inventoryError(
          `runtime inventory: tool '${canonical}' command missing name.`,
          'tool-command-missing-name',
          { tool: canonical },
        );
      }
      const parent = readString(spec, 'parent');
      const path = parent === undefined ? name : `${parent} ${name}`;
      leaves.push(projectLeafFromSpec(spec, path, 'tool', canonical, facts));
    }
  }
}

/**
 * Project any toolCommandSpecs not already covered by the registry pass
 * (defensive: registration input is the mount surface; registry is identity).
 */
function projectExtraToolSpecLeaves(
  input: BuildRuntimeCommandInventoryInput,
  toolFacts: ReadonlyMap<string, ToolIdentityFacts>,
  leaves: RuntimeCommandLeaf[],
): void {
  const seenPaths = new Set(leaves.map((l) => l.path));
  for (const spec of input.toolCommandSpecs) {
    if (spec === null || typeof spec !== 'object') continue;
    const name = readString(spec, 'name');
    if (name === undefined) continue;
    const parent = readString(spec, 'parent');
    const path = parent === undefined ? name : `${parent} ${name}`;
    if (seenPaths.has(path)) continue;
    const tool = toolForCommand(input.toolRegistry, name, parent);
    const ownerLabel = tool?.identity.name ?? parent ?? name;
    const facts = toolFacts.get(ownerLabel);
    leaves.push(projectLeafFromSpec(spec, path, 'tool', ownerLabel, facts));
    seenPaths.add(path);
  }
}

/**
 * Top-level host commands.
 *
 * @throws {Error} When a host spec is invalid or leaf projection fails.
 */
function projectHostSpecLeaves(hostSpecs: readonly object[], leaves: RuntimeCommandLeaf[]): void {
  for (const spec of hostSpecs) {
    if (spec === null || typeof spec !== 'object') {
      inventoryError('runtime inventory: invalid host command spec.', 'host-invalid-spec');
    }
    const name = readString(spec, 'name');
    if (name === undefined) {
      inventoryError('runtime inventory: host command missing name.', 'host-missing-name');
    }
    leaves.push(projectLeafFromSpec(spec, name, 'host', 'cli'));
  }
}

/**
 * Action-less host groups plus their leaves.
 *
 * @throws {Error} When a host group leaf is missing a name or projection fails.
 */
function projectHostGroups(
  hostGroups: readonly HostSubcommandGroup[],
  groups: RuntimeCommandGroup[],
  leaves: RuntimeCommandLeaf[],
): void {
  for (const group of hostGroups) {
    groups.push({
      path: group.name,
      name: group.name,
      owner: 'host',
      ownerLabel: 'cli',
      visibility: 'public',
    });
    for (const leaf of group.leaves) {
      const leafName = readString(leaf, 'name');
      if (leafName === undefined) {
        inventoryError(
          `runtime inventory: host group '${group.name}' leaf missing name.`,
          'host-leaf-missing-name',
          { path: group.name },
        );
      }
      leaves.push(projectLeafFromSpec(leaf, `${group.name} ${leafName}`, 'host', 'cli'));
    }
  }
}

/**
 * Per-tool plugin groups: `<tool> plugin <leaf>`.
 *
 * @throws {Error} When a plugin group leaf is missing a name or projection fails.
 */
function projectToolPluginGroups(
  toolPluginGroups: readonly ToolPluginGroup[],
  toolFacts: ReadonlyMap<string, ToolIdentityFacts>,
  groups: RuntimeCommandGroup[],
  leaves: RuntimeCommandLeaf[],
): void {
  for (const group of toolPluginGroups) {
    const groupPath = `${group.parentVerb} plugin`;
    groups.push({
      path: groupPath,
      name: 'plugin',
      owner: 'tool',
      ownerLabel: group.parentVerb,
      visibility: 'public',
    });
    for (const leaf of group.leaves) {
      const leafName = readString(leaf, 'name');
      if (leafName === undefined) {
        inventoryError(
          `runtime inventory: plugin group '${groupPath}' leaf missing name.`,
          'plugin-leaf-missing-name',
          { path: groupPath },
        );
      }
      leaves.push(
        projectLeafFromSpec(
          leaf,
          `${groupPath} ${leafName}`,
          'tool',
          group.parentVerb,
          toolFacts.get(group.parentVerb),
        ),
      );
    }
  }
}

/**
 * Project the complete mounted command surface into a plain frozen inventory.
 * Fail-closed on duplicate paths, caps, accessors, and invalid specs.
 */
export function buildRuntimeCommandInventory(
  input: BuildRuntimeCommandInventoryInput,
): RuntimeCommandInventory {
  const limits = input.limits ?? PRODUCTION_LIMITS;
  const leaves: RuntimeCommandLeaf[] = [];
  const groups: RuntimeCommandGroup[] = [];
  const toolFacts = indexToolFacts(
    input.toolRegistry,
    input.manifests ?? [],
    input.provenance ?? [],
  );

  projectRegistryToolLeaves(input.toolRegistry, toolFacts, leaves);
  projectExtraToolSpecLeaves(input, toolFacts, leaves);
  projectHostSpecLeaves(input.hostSpecs, leaves);
  projectHostGroups(input.hostGroups, groups, leaves);
  projectToolPluginGroups(input.toolPluginGroups, toolFacts, groups, leaves);

  return createRuntimeCommandInventory(
    {
      complete: true,
      leaves,
      groups,
      reasons: [],
    },
    limits,
  );
}
