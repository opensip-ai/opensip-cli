/**
 * Composition-root projector: declarative CommandSpecs → plain RuntimeCommandInventory.
 *
 * Built once from the same host/Tool surfaces used for mounting and scope
 * indexing so MCP runtime wiring never retains live handlers or CLI closures.
 * MCP cannot import this module (layer DAG); it only reads `scope.runtimeCommands`.
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
  type StaticHandlerDescriptor,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import type { HostSubcommandGroup, ToolPluginGroup } from '../commands/host-subcommand-groups.js';

/** Production limits mirrored from core constants (immutable). */
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

type OwnProperty =
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'missing' | 'accessor' | 'invalid' };

function readOwn(target: object, key: PropertyKey): OwnProperty {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor === undefined) return { kind: 'missing' };
    if (!('value' in descriptor)) return { kind: 'accessor' };
    return { kind: 'data', value: descriptor.value };
  } catch {
    return { kind: 'invalid' };
  }
}

function ownData(target: object, key: PropertyKey): unknown {
  const property = readOwn(target, key);
  return property.kind === 'data' ? property.value : undefined;
}

function readString(target: object, key: PropertyKey): string | undefined {
  const value = ownData(target, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readStringArray(target: object, key: PropertyKey): readonly string[] {
  const value = ownData(target, key);
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = readOwn(value, String(i));
    if (item.kind === 'data' && typeof item.value === 'string' && item.value !== '') {
      out.push(item.value);
    }
  }
  return out;
}

function readStaticHandler(target: object): StaticHandlerDescriptor | undefined {
  const property = readOwn(target, 'staticHandler');
  if (property.kind === 'missing') return undefined;
  if (property.kind !== 'data' || property.value === null || typeof property.value !== 'object') {
    throw new Error('runtime inventory: staticHandler must be own data plain object.');
  }
  const descriptor = property.value as object;
  const pkg = readString(descriptor, 'package');
  const path = readString(descriptor, 'path');
  const declaration = readString(descriptor, 'declaration');
  if (pkg === undefined || path === undefined || declaration === undefined) {
    throw new Error('runtime inventory: staticHandler missing package/path/declaration.');
  }
  return { package: pkg, path, declaration };
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

function projectLeafFromSpec(
  spec: object,
  path: string,
  owner: RuntimeCommandLeaf['owner'],
  ownerLabel: string,
  facts?: ToolIdentityFacts,
): RuntimeCommandLeaf {
  const name = readString(spec, 'name');
  if (name === undefined) {
    throw new Error(`runtime inventory: command at '${path}' missing name.`);
  }
  const output = readString(spec, 'output');
  if (output === undefined) {
    throw new Error(`runtime inventory: command '${path}' missing output.`);
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
    throw new Error(`runtime inventory: command '${path}' handler missing or accessor.`);
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

  // Tool commands (flat or parent-nested). Prefer registry tools so each leaf
  // carries admitted provenance/package identity when available.
  for (const tool of input.toolRegistry.values()) {
    const canonical = tool.identity.name;
    const facts = toolFacts.get(canonical);
    const specs = tool.commandSpecs ?? [];
    for (const spec of specs) {
      if (spec === null || typeof spec !== 'object') {
        throw new Error(`runtime inventory: tool '${canonical}' has invalid commandSpecs entry.`);
      }
      const name = readString(spec, 'name');
      if (name === undefined) {
        throw new Error(`runtime inventory: tool '${canonical}' command missing name.`);
      }
      const parent = readString(spec, 'parent');
      const path = parent === undefined ? name : `${parent} ${name}`;
      leaves.push(projectLeafFromSpec(spec, path, 'tool', canonical, facts));
    }
  }

  // Also project any toolCommandSpecs not already covered (defensive: registration
  // input is the mount surface; registry is the identity source).
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

  // Top-level host commands.
  for (const spec of input.hostSpecs) {
    if (spec === null || typeof spec !== 'object') {
      throw new Error('runtime inventory: invalid host command spec.');
    }
    const name = readString(spec, 'name');
    if (name === undefined) {
      throw new Error('runtime inventory: host command missing name.');
    }
    leaves.push(projectLeafFromSpec(spec, name, 'host', 'cli'));
  }

  // Action-less host groups + leaves.
  for (const group of input.hostGroups) {
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
        throw new Error(`runtime inventory: host group '${group.name}' leaf missing name.`);
      }
      leaves.push(projectLeafFromSpec(leaf, `${group.name} ${leafName}`, 'host', 'cli'));
    }
  }

  // Per-tool plugin groups: `<tool> plugin <leaf>`.
  for (const group of input.toolPluginGroups) {
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
        throw new Error(`runtime inventory: plugin group '${groupPath}' leaf missing name.`);
      }
      leaves.push(
        projectLeafFromSpec(leaf, `${groupPath} ${leafName}`, 'tool', group.parentVerb, toolFacts.get(group.parentVerb)),
      );
    }
  }

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
