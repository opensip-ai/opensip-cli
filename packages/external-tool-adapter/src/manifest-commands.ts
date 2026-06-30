/**
 * @fileoverview Manifest command-shell derivation (ADR-0090, Phase-0 decision 7).
 *
 * An installed adapter mounts from its STATIC `package.json#opensipTools.commands`,
 * not its runtime — and `assertCommandNamesMatch` THROWS if the static shells
 * drift from the runtime `commandSpecs` (at install + worker import). So the
 * shells must be GENERATED from the runtime, never hand-authored.
 *
 * `deriveAdapterManifestCommands(tool)` produces exactly that serializable data
 * (the scan + doctor + version shells). A Phase-3 generator extension
 * (`build-tool-command-manifests.mjs`) writes it into each adapter package.json
 * and `--check`s parity; this helper is the single source the generator consumes.
 */

import { isAbsolute } from 'node:path';

import type { ManifestCommandShell } from './types.js';
import type { ManifestOptionDescriptor, OptionSpec, Tool } from '@opensip-cli/core';

/**
 * `OptionSpec` → `ManifestOptionDescriptor`: every field except the
 * non-serializable `parse` closure, and minus a machine-specific absolute-path
 * string `default` (resolved lazily at runtime, so baking it would make the
 * manifest non-deterministic). Byte-identical to the shared generator's
 * `deriveOptionDescriptor` (`scripts/build-tool-command-manifests.mjs`), so the
 * two derivation paths agree (the `tool.test.ts` parity guard pins this).
 */
function toManifestOption(option: OptionSpec): ManifestOptionDescriptor {
  const dropDefault = typeof option.default === 'string' && isAbsolute(option.default);
  const entries = Object.entries(option).filter(
    ([key]) => key !== 'parse' && !(dropDefault && key === 'default'),
  );
  return Object.fromEntries(entries) as ManifestOptionDescriptor;
}

/**
 * Derive the serializable `opensipTools.commands` shells from a built adapter
 * {@link Tool}'s `commandSpecs` — name, description, aliases, common flags,
 * options (e.g. the gate flags, minus `parse`), scope, output mode, the nesting
 * `parent`, and (for `raw-stream`) the `rawStreamReason`. Pure.
 */
export function deriveAdapterManifestCommands(tool: Tool): readonly ManifestCommandShell[] {
  return (tool.commandSpecs ?? []).map((spec) => ({
    name: spec.name,
    description: spec.description,
    aliases: [...(spec.aliases ?? [])],
    commonFlags: [...spec.commonFlags],
    ...(spec.options === undefined ? {} : { options: spec.options.map(toManifestOption) }),
    scope: spec.scope,
    output: spec.output,
    ...(spec.parent === undefined ? {} : { parent: spec.parent }),
    ...(spec.rawStreamReason === undefined ? {} : { rawStreamReason: spec.rawStreamReason }),
    ...(spec.producesVerdict === undefined ? {} : { producesVerdict: spec.producesVerdict }),
  }));
}
