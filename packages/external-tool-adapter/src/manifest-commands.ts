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

import type { ManifestCommandShell } from './types.js';
import type { Tool } from '@opensip-cli/core';

/**
 * Derive the serializable `opensipTools.commands` shells from a built adapter
 * {@link Tool}'s `commandSpecs` — name, description, aliases, common flags,
 * scope, output mode, the nesting `parent`, and (for `raw-stream`) the
 * `rawStreamReason`. Pure.
 */
export function deriveAdapterManifestCommands(tool: Tool): readonly ManifestCommandShell[] {
  return (tool.commandSpecs ?? []).map((spec) => ({
    name: spec.name,
    description: spec.description,
    aliases: [...(spec.aliases ?? [])],
    commonFlags: [...spec.commonFlags],
    scope: spec.scope,
    output: spec.output,
    ...(spec.parent === undefined ? {} : { parent: spec.parent }),
    ...(spec.rawStreamReason === undefined ? {} : { rawStreamReason: spec.rawStreamReason }),
  }));
}
