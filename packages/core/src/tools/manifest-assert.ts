/**
 * @fileoverview Load-time manifest⇔Tool drift guard (launch, Phase 1).
 */

import { ValidationError } from '../lib/errors.js';

import { resolveToolCommandNames } from './derive-commands-from-specs.js';
import { validateToolIdentity } from './identity.js';
import { resolveToolHooks } from './resolve-tool-hooks.js';

import type { ToolPluginManifest } from './manifest.js';
import type { Tool } from './types.js';

function commandAliasesEqual(
  a: readonly string[] | undefined,
  b: readonly string[],
): boolean {
  const left = a ?? [];
  if (left.length !== b.length) return false;
  return left.every((value, index) => value === b[index]);
}

/**
 * Assert that a static `ToolPluginManifest` matches the runtime `Tool` it
 * declares.
 */
export function assertManifestMatchesTool(manifest: ToolPluginManifest, tool: Tool): void {
  const runtimeHuman = tool.metadata.name;

  if (manifest.id !== runtimeHuman) {
    throw new ValidationError(
      `tool manifest id '${manifest.id}' does not match runtime tool name '${runtimeHuman}'`,
    );
  }

  if (manifest.stableId !== undefined && manifest.stableId !== tool.metadata.id) {
    throw new ValidationError(
      `tool manifest stableId '${manifest.stableId}' does not match runtime tool id '${tool.metadata.id}'`,
    );
  }

  if (manifest.identity !== undefined) {
    const normalized = validateToolIdentity(manifest.identity);
    if (normalized.name !== tool.identity.name) {
      throw new ValidationError(
        `tool manifest identity.name '${normalized.name}' does not match runtime identity.name '${tool.identity.name}'`,
      );
    }
    if (manifest.id !== normalized.name) {
      throw new ValidationError(
        `tool manifest id '${manifest.id}' must equal identity.name '${normalized.name}'`,
      );
    }
    if (!commandAliasesEqual(manifest.identity.aliases, normalized.aliases)) {
      throw new ValidationError('tool manifest identity.aliases do not match runtime identity.aliases');
    }
    const layoutKey = normalized.layoutKey;
    if (manifest.pluginLayout !== undefined && manifest.pluginLayout.domain !== layoutKey) {
      throw new ValidationError(
        `tool manifest pluginLayout.domain '${manifest.pluginLayout.domain}' must equal layoutKey '${layoutKey}'`,
      );
    }
    if (manifest.config !== undefined && manifest.config.namespace !== normalized.name) {
      throw new ValidationError(
        `tool manifest config.namespace '${manifest.config.namespace}' must equal identity.name '${normalized.name}'`,
      );
    }
  }

  const hooks = resolveToolHooks(tool);
  const primarySpec = tool.commandSpecs?.find(
    (spec) => spec.parent === undefined && spec.name === tool.metadata.name,
  );
  if (primarySpec !== undefined && manifest.identity !== undefined) {
    const normalized = validateToolIdentity(manifest.identity);
    if (!commandAliasesEqual(primarySpec.aliases, [...normalized.aliases])) {
      throw new ValidationError(
        'tool manifest primary command aliases do not match runtime primary spec aliases',
      );
    }
  }

  const manifestNames = new Set(manifest.commands.map((c) => c.name));
  const toolNames = new Set(resolveToolCommandNames(tool));

  const missingFromManifest = [...toolNames]
    .filter((n) => !manifestNames.has(n))
    .sort((a, b) => a.localeCompare(b));
  const extraInManifest = [...manifestNames]
    .filter((n) => !toolNames.has(n))
    .sort((a, b) => a.localeCompare(b));

  if (missingFromManifest.length > 0 || extraInManifest.length > 0) {
    const parts: string[] = [];
    if (missingFromManifest.length > 0) {
      parts.push(`missing from manifest: [${missingFromManifest.join(', ')}]`);
    }
    if (extraInManifest.length > 0) {
      parts.push(`declared in manifest but not in tool: [${extraInManifest.join(', ')}]`);
    }
    throw new ValidationError(
      `tool manifest commands for '${manifest.id}' do not match runtime tool commands (${parts.join('; ')})`,
    );
  }

  if (hooks.sessionReplay !== undefined && tool.pluginLayout !== undefined) {
    const layoutKey = validateToolIdentity(tool.identity).layoutKey;
    if (hooks.sessionReplay.tool !== layoutKey) {
      throw new ValidationError(
        `runtime sessionReplay.tool '${hooks.sessionReplay.tool}' must equal layoutKey '${layoutKey}'`,
      );
    }
  }
}