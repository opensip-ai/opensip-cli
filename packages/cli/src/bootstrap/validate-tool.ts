/**
 * Runtime shape validation for third-party `tool` exports — the
 * untrusted boundary where `discoverAndRegisterToolPackages` imports
 * an arbitrary npm package and inspects whatever it exports.
 *
 * Verifies the minimal contract the registry depends on: a
 * `metadata.id` string (used for dedupe + listing), and a command surface —
 * a non-empty `commandSpecs` array (the one command
 * surface as of launch; `register()` was removed). A tool with no `commandSpecs`
 * cannot mount any command, so it fails the shape check. Lifecycle hooks belong
 * under `extensionPoints` only — top-level hooks are rejected with an actionable
 * diagnostic.
 *
 * Ordering vs. the admission gate: this shape check runs AFTER a
 * tool's module is imported. The compatibility gate (`admitTool`) and the
 * project-local TRUST gate (`admitProjectLocalTool`, deny-by-default) run
 * on the STATIC manifest *before* import — so a project-local executable
 * tool that is not allowlisted is fail-closed without its code ever running,
 * and never reaches `isValidTool`.
 */

import { validateCommandSpec, type Tool } from '@opensip-cli/core';

/** Top-level hook keys removed in the tool-author-simplify contract. */
const LEGACY_TOP_LEVEL_HOOK_KEYS = [
  'initialize',
  'contributeScope',
  'collectReportData',
  'sessionReplay',
  'config',
  'capabilityRegistrars',
  'fingerprintStrategy',
  'scaffoldExamples',
  'stableExampleIds',
  'scaffoldConfigBlock',
] as const;

function legacyTopLevelHookKeys(candidate: Record<string, unknown>): readonly string[] {
  return LEGACY_TOP_LEVEL_HOOK_KEYS.filter((key) => candidate[key] !== undefined);
}

function metadataValidationFailure(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null) {
    return 'tool.metadata is missing or not an object';
  }
  if (typeof (metadata as { id?: unknown }).id !== 'string') {
    return 'tool.metadata.id must be a string';
  }
  return undefined;
}

function commandSpecsValidationFailure(commandSpecs: unknown): string | undefined {
  if (!Array.isArray(commandSpecs) || commandSpecs.length === 0) {
    return 'tool.commandSpecs must be a non-empty array (the declarative command surface)';
  }
  for (const spec of commandSpecs) {
    if (!validateCommandSpec(spec)) {
      return 'tool.commandSpecs contains an invalid CommandSpec';
    }
  }
  return undefined;
}

function optionalCommandsValidationFailure(commands: unknown): string | undefined {
  if (!Array.isArray(commands)) return undefined;
  for (const cmd of commands) {
    if (typeof cmd !== 'object' || cmd === null) {
      return 'tool.commands contains a non-object entry';
    }
    if (typeof (cmd as { name?: unknown }).name !== 'string') {
      return 'tool.commands entries must include a string name';
    }
  }
  return undefined;
}

/**
 * Human-readable rejection reason for an exported `tool` value.
 * `undefined` means the export satisfies {@link isValidTool}.
 */
export function toolValidationFailure(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return 'tool export is not an object';
  }
  const candidate = value as Record<string, unknown>;

  const metadataFailure = metadataValidationFailure(candidate.metadata);
  if (metadataFailure !== undefined) return metadataFailure;

  const legacy = legacyTopLevelHookKeys(candidate);
  if (legacy.length > 0) {
    return (
      `tool declares deprecated top-level hooks [${legacy.join(', ')}]; ` +
      'move them under extensionPoints (see opensip tool authoring docs)'
    );
  }

  const specsFailure = commandSpecsValidationFailure(candidate.commandSpecs);
  if (specsFailure !== undefined) return specsFailure;

  return optionalCommandsValidationFailure(candidate.commands);
}

export function isValidTool(value: unknown): value is Tool {
  return toolValidationFailure(value) === undefined;
}
