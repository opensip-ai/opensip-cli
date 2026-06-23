/**
 * Tool identity index — resolve canonical name | alias | layoutKey.
 */

import { resolveToolHooks } from './resolve-tool-hooks.js';
import { validateToolIdentity } from './identity.js';

import type { ToolIdentity } from './identity.js';
import type { ToolRegistry } from './registry.js';

export interface ToolIdentityBinding {
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly layoutKey: string;
}

export interface ToolIdentityIndex {
  readonly bindings: readonly ToolIdentityBinding[];
  resolveInput(input: string): ToolIdentityBinding | undefined;
  canonicalForStoredTool(tool: string): string;
}

function bindingFromTool(identity: ToolIdentity, layoutKey: string): ToolIdentityBinding {
  const normalized = validateToolIdentity(identity);
  return {
    canonicalName: normalized.name,
    aliases: normalized.aliases,
    layoutKey,
  };
}

/** Build an identity index from the live tool registry. */
export function buildToolIdentityIndex(registry: ToolRegistry): ToolIdentityIndex {
  const bindings: ToolIdentityBinding[] = [];
  const inputToBinding = new Map<string, ToolIdentityBinding>();

  for (const tool of registry.list()) {
    const identity = tool.identity;
    if (identity === undefined) continue;

    const hooks = resolveToolHooks(tool);
    const layoutKey =
      tool.pluginLayout?.domain ?? hooks.sessionReplay?.tool ?? identity.layoutKey ?? identity.name;
    const binding = bindingFromTool(identity, layoutKey);

    bindings.push(binding);
    inputToBinding.set(binding.canonicalName, binding);
    for (const alias of binding.aliases) {
      inputToBinding.set(alias, binding);
    }
    inputToBinding.set(binding.layoutKey, binding);
    if (hooks.sessionReplay?.tool) {
      inputToBinding.set(hooks.sessionReplay.tool, binding);
    }
    if (tool.pluginLayout?.domain) {
      inputToBinding.set(tool.pluginLayout.domain, binding);
    }
  }

  return {
    bindings,
    resolveInput(input: string): ToolIdentityBinding | undefined {
      return inputToBinding.get(input);
    },
    canonicalForStoredTool(tool: string): string {
      return inputToBinding.get(tool)?.canonicalName ?? tool;
    },
  };
}

/** Resolve a user-facing tool filter to the persisted layoutKey. */
export function resolveToolFilterToLayoutKey(
  registry: ToolRegistry,
  filter: string | undefined,
): string | undefined {
  if (filter === undefined) return undefined;
  const index = buildToolIdentityIndex(registry);
  const binding = index.resolveInput(filter);
  return binding?.layoutKey ?? filter;
}