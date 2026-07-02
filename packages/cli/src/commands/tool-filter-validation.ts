import {
  registeredToolShortIds,
  resolveToolFilterToLayoutKey,
  type ToolRegistry,
} from '@opensip-cli/core';

export interface ToolFilterValidationFailure {
  readonly message: string;
  readonly code: string;
}

export interface ToolFilterValidationOptions {
  readonly requiredMessage?: string;
  readonly requiredCode?: string;
}

export function validateRegisteredToolFilter(
  registry: ToolRegistry | undefined,
  tool: string | undefined,
  options: ToolFilterValidationOptions = {},
): ToolFilterValidationFailure | undefined {
  if (tool === undefined) {
    if (options.requiredMessage === undefined) return undefined;
    return {
      code: options.requiredCode ?? 'missing-tool',
      message: options.requiredMessage,
    };
  }
  if (registry === undefined) return undefined;
  const known = registeredToolShortIds(registry);
  const resolved = resolveToolFilterToLayoutKey(registry, tool) ?? tool;
  if (known.has(tool) || known.has(resolved)) return undefined;
  const knownList = [...known].sort();
  return {
    code: 'unknown-tool',
    message:
      `unknown tool '${tool}'` +
      (knownList.length > 0 ? `; registered tools: ${knownList.join(', ')}` : ''),
  };
}

export function resolveRegisteredToolFilter(
  registry: ToolRegistry | undefined,
  tool: string | undefined,
): string | undefined {
  if (registry === undefined || tool === undefined) return tool;
  return resolveToolFilterToLayoutKey(registry, tool);
}
