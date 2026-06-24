/**
 * Tool identity index — resolve canonical name | alias | layoutKey.
 */

import { ValidationError } from '../lib/errors.js';

import { validateToolIdentity } from './identity.js';
import { resolveToolHooks } from './resolve-tool-hooks.js';

import type { ToolIdentity } from './identity.js';
import type { ToolRegistry } from './registry.js';

/** Canonical tool identity plus its resolved plugin layout key. */
export interface ToolIdentityBinding {
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly layoutKey: string;
}

/** Registry-backed lookup from user input to a tool identity binding. */
export interface ToolIdentityIndex {
  readonly bindings: readonly ToolIdentityBinding[];
  resolveInput(input: string): ToolIdentityBinding | undefined;
  canonicalForStoredTool(tool: string): string;
}

function assertIdentityInputAvailable(
  inputToBinding: Map<string, ToolIdentityBinding>,
  input: string,
  binding: ToolIdentityBinding,
): void {
  const incumbent = inputToBinding.get(input);
  if (incumbent === undefined || incumbent.canonicalName === binding.canonicalName) {
    return;
  }
  throw new ValidationError(
    `Tool identity input '${input}' is declared by both '${incumbent.canonicalName}' and '${binding.canonicalName}'.`,
    { code: 'TOOL.IDENTITY.CONFLICT' },
  );
}

function addIdentityInput(
  inputToBinding: Map<string, ToolIdentityBinding>,
  input: string | undefined,
  binding: ToolIdentityBinding,
): void {
  if (input === undefined) return;
  assertIdentityInputAvailable(inputToBinding, input, binding);
  inputToBinding.set(input, binding);
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

  // Small registered-tool set per CLI invocation (batch limit irrelevant).
  for (const tool of registry.list()) {
    const identity = tool.identity;
    if (identity === undefined) {
      throw new ValidationError(`Registered tool '${tool.metadata.name}' is missing identity.`, {
        code: 'TOOL.IDENTITY.REQUIRED',
      });
    }

    const hooks = resolveToolHooks(tool);
    const layoutKey =
      tool.pluginLayout?.domain ?? hooks.sessionReplay?.tool ?? identity.layoutKey ?? identity.name;
    const binding = bindingFromTool(identity, layoutKey);

    bindings.push(binding);
    addIdentityInput(inputToBinding, binding.canonicalName, binding);
    // Small alias list per tool identity (batch limit irrelevant).
    for (const alias of binding.aliases) {
      addIdentityInput(inputToBinding, alias, binding);
    }
    addIdentityInput(inputToBinding, binding.layoutKey, binding);
    addIdentityInput(inputToBinding, hooks.sessionReplay?.tool, binding);
    addIdentityInput(inputToBinding, tool.pluginLayout?.domain, binding);
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
