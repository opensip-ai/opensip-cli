/**
 * config-declarations — shared config declaration assembly for the dispatcher
 * and `opensip config validate|schema` operator commands.
 *
 * Extracted from `config-and-capabilities.ts` so schema composition uses the
 * same declaration set without duplicating provenance/manifest folding logic.
 */

import {
  decorateToolConfigDeclarationsWithGateKeys,
  hostConfigDeclarations,
  jsonSchemaObjectToZod,
  type PluginConfigKeyDeclaration,
  type ToolConfigDeclaration,
} from '@opensip-cli/config';
import {
  ConfigurationError,
  resolveToolHooks,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';

import { provenanceSourceFor } from './tool-provenance.js';

function manifestDescriptorFor(
  tool: Tool,
  manifests: readonly ToolPluginManifest[],
): ToolPluginManifest['config'] {
  const manifest =
    manifests.find((m) => m.stableId !== undefined && m.stableId === tool.metadata.id) ??
    manifests.find((m) => m.id === tool.metadata.name);
  return manifest?.config;
}

function collectDeclarations(
  tools: ToolRegistry,
  provenance: readonly ToolProvenance[],
  manifests: readonly ToolPluginManifest[],
): readonly ToolConfigDeclaration[] {
  const declarations: ToolConfigDeclaration[] = [];
  for (const tool of tools.list()) {
    if (provenanceSourceFor(tool, provenance) === 'bundled') {
      const config = resolveToolHooks(tool).config;
      if (config !== undefined) {
        declarations.push(config as ToolConfigDeclaration);
      }
      continue;
    }
    const descriptor = manifestDescriptorFor(tool, manifests);
    if (descriptor !== undefined) {
      declarations.push({
        namespace: descriptor.namespace,
        schema: jsonSchemaObjectToZod(descriptor.schema),
      });
    }
  }
  return declarations;
}

function addPluginConfigKey(
  keys: Map<string, PluginConfigKeyDeclaration['kind']>,
  key: string | undefined,
  kind: PluginConfigKeyDeclaration['kind'],
): void {
  if (key === undefined) return;
  const existing = keys.get(key);
  if (existing !== undefined && existing !== kind) {
    throw new ConfigurationError(
      `Plugin config key '${key}' is declared with conflicting value kinds (${existing}, ${kind}).`,
      { code: 'CONFIGURATION_ERROR', namespace: 'plugins' },
    );
  }
  keys.set(key, kind);
}

function collectPluginConfigKeys(
  manifests: readonly ToolPluginManifest[],
): readonly PluginConfigKeyDeclaration[] {
  const keys = new Map<string, PluginConfigKeyDeclaration['kind']>();
  for (const manifest of manifests) {
    for (const capability of manifest.capabilities ?? []) {
      const configKeys = capability.discovery?.configKeys;
      if (configKeys === undefined) continue;
      addPluginConfigKey(keys, configKeys.packages, 'packages');
      addPluginConfigKey(keys, configKeys.autoDiscover, 'autoDiscover');
      addPluginConfigKey(keys, configKeys.scopes, 'scopes');
    }
  }
  return [...keys.entries()].map(([key, kind]) => ({ key, kind }));
}

export interface ConfigDeclarationBundle {
  readonly declarations: readonly ToolConfigDeclaration[];
  /** True when at least one registered tool contributed a config namespace. */
  readonly hasToolNamespaces: boolean;
}

/**
 * Build the ordered declaration array the dispatcher and config commands use.
 */
export function buildConfigDeclarations(args: {
  readonly tools: ToolRegistry;
  readonly manifests?: readonly ToolPluginManifest[];
  readonly provenance?: readonly ToolProvenance[];
}): ConfigDeclarationBundle {
  const { tools, manifests = [], provenance = [] } = args;
  const toolDeclarations = decorateToolConfigDeclarationsWithGateKeys(
    collectDeclarations(tools, provenance, manifests),
  );
  const declarations = [
    ...hostConfigDeclarations({
      pluginConfigKeys: collectPluginConfigKeys(manifests),
    }),
    ...toolDeclarations,
  ];
  return { declarations, hasToolNamespaces: toolDeclarations.length > 0 };
}
