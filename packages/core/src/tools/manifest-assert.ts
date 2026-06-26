/**
 * @fileoverview Load-time manifest⇔Tool drift guard (launch, Phase 1).
 */

import { ValidationError } from '../lib/errors.js';

import { resolveToolCommandNames } from './derive-commands-from-specs.js';
import { validateToolIdentity } from './identity.js';
import { resolveToolHooks } from './resolve-tool-hooks.js';

import type { ToolPluginManifest } from './manifest.js';
import type { Tool } from './types.js';

type NormalizedToolIdentity = ReturnType<typeof validateToolIdentity>;

function commandAliasesEqual(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const left = a ?? [];
  if (left.length !== b.length) return false;
  return left.every((value, index) => value === b[index]);
}

function assertManifestMetadata(manifest: ToolPluginManifest, tool: Tool): void {
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
}

function assertManifestIdentity(
  manifest: ToolPluginManifest,
  manifestIdentity: NormalizedToolIdentity,
  runtimeIdentity: NormalizedToolIdentity,
): void {
  if (manifestIdentity.name !== runtimeIdentity.name) {
    throw new ValidationError(
      `tool manifest identity.name '${manifestIdentity.name}' does not match runtime identity.name '${runtimeIdentity.name}'`,
    );
  }
  if (manifest.id !== manifestIdentity.name) {
    throw new ValidationError(
      `tool manifest id '${manifest.id}' must equal identity.name '${manifestIdentity.name}'`,
    );
  }
  if (!commandAliasesEqual(manifestIdentity.aliases, runtimeIdentity.aliases)) {
    throw new ValidationError(
      'tool manifest identity.aliases do not match runtime identity.aliases',
    );
  }
}

function assertLayoutAndConfig(
  manifest: ToolPluginManifest,
  tool: Tool,
  manifestIdentity: NormalizedToolIdentity,
  runtimeIdentity: NormalizedToolIdentity,
): void {
  const layoutKey = manifestIdentity.layoutKey;
  if (manifest.pluginLayout !== undefined && manifest.pluginLayout.domain !== layoutKey) {
    throw new ValidationError(
      `tool manifest pluginLayout.domain '${manifest.pluginLayout.domain}' must equal layoutKey '${layoutKey}'`,
    );
  }
  if (tool.pluginLayout !== undefined && tool.pluginLayout.domain !== runtimeIdentity.layoutKey) {
    throw new ValidationError(
      `runtime pluginLayout.domain '${tool.pluginLayout.domain}' must equal layoutKey '${runtimeIdentity.layoutKey}'`,
    );
  }
  if (manifest.config !== undefined && manifest.config.namespace !== manifestIdentity.name) {
    throw new ValidationError(
      `tool manifest config.namespace '${manifest.config.namespace}' must equal identity.name '${manifestIdentity.name}'`,
    );
  }
}

function assertPrimaryAliases(tool: Tool, manifestIdentity: NormalizedToolIdentity): void {
  const primarySpec = tool.commandSpecs?.find(
    (spec) => spec.parent === undefined && spec.name === tool.metadata.name,
  );
  if (primarySpec === undefined) return;
  if (commandAliasesEqual(primarySpec.aliases, [...manifestIdentity.aliases])) return;
  throw new ValidationError(
    'tool manifest primary command aliases do not match runtime primary spec aliases',
  );
}

function assertCommandNamesMatch(manifest: ToolPluginManifest, tool: Tool): void {
  const manifestNames = new Set(manifest.commands.map((c) => c.name));
  const toolNames = new Set(resolveToolCommandNames(tool));

  const missingFromManifest = [...toolNames]
    .filter((n) => !manifestNames.has(n))
    .sort((a, b) => a.localeCompare(b));
  const extraInManifest = [...manifestNames]
    .filter((n) => !toolNames.has(n))
    .sort((a, b) => a.localeCompare(b));

  if (missingFromManifest.length === 0 && extraInManifest.length === 0) return;

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

function assertSessionReplayLayout(tool: Tool, runtimeIdentity: NormalizedToolIdentity): void {
  const hooks = resolveToolHooks(tool);
  if (hooks.sessionReplay === undefined || tool.pluginLayout === undefined) return;
  const layoutKey = runtimeIdentity.layoutKey;
  if (hooks.sessionReplay.tool !== layoutKey) {
    throw new ValidationError(
      `runtime sessionReplay.tool '${hooks.sessionReplay.tool}' must equal layoutKey '${layoutKey}'`,
    );
  }
}

/**
 * Assert that a static `ToolPluginManifest` matches the runtime `Tool` it
 * declares.
 *
 * Runtime-only descriptor data such as `extensionPoints.contractVersions` is
 * intentionally out of scope — manifests carry admission facts, not per-domain
 * string contract markers (ADR-0074).
 */
export function assertManifestMatchesTool(manifest: ToolPluginManifest, tool: Tool): void {
  const manifestIdentity = validateToolIdentity(manifest.identity);
  const runtimeIdentity = validateToolIdentity(tool.identity);

  assertManifestMetadata(manifest, tool);
  assertManifestIdentity(manifest, manifestIdentity, runtimeIdentity);
  assertLayoutAndConfig(manifest, tool, manifestIdentity, runtimeIdentity);
  assertPrimaryAliases(tool, manifestIdentity);
  assertCommandNamesMatch(manifest, tool);
  assertSessionReplayLayout(tool, runtimeIdentity);
}
