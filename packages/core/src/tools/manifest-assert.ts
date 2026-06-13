/**
 * @fileoverview Load-time manifest⇔Tool drift guard (launch, Phase 1).
 *
 * The static `ToolPluginManifest` (declared in `package.json#opensipTools`)
 * and the runtime `Tool` (`metadata.id` + `commands[]`) are two declarations
 * of the same identity. For launch the open question is resolved as **assert
 * equality at load** — the manifest must match the tool it ships with;
 * single-sourcing the two is deferred to launch (when `ToolMetadata` can change
 * shape). This helper is that assertion: a typed throw on the first sign of
 * drift, called by the Phase 5 as-if-external test and (defensively) by the
 * Phase 3 bundled-load path.
 *
 * Equality is checked on the identity subset only:
 *   - `manifest.id === tool.metadata.id`, and
 *   - the **set** of command names is identical (order-insensitive).
 * Descriptions/aliases are NOT compared — they are display strings the
 * host does not key off, and pinning them here would make every wording
 * tweak a two-file edit without buying any safety.
 */

import { ValidationError } from '../lib/errors.js';

import type { ToolPluginManifest } from './manifest.js';
import type { Tool } from './types.js';

/**
 * Assert that a static `ToolPluginManifest` matches the runtime `Tool` it
 * declares — same `id`, same set of command names. Throws `ValidationError`
 * on any mismatch; returns `void` when they agree.
 *
 * This is the drift guard between the two identity declarations: the
 * `package.json#opensipTools` manifest (read before importing the module)
 * and the imported `Tool` (`metadata.id` + `commands[]`). Catches a manifest
 * that fell out of sync with the tool's runtime command surface.
 *
 * @param manifest The static manifest read from `package.json#opensipTools`.
 * @param tool The runtime tool the manifest is supposed to describe.
 * @throws {ValidationError} when `id` differs, or the command-name sets differ.
 */
export function assertManifestMatchesTool(manifest: ToolPluginManifest, tool: Tool): void {
  if (manifest.id !== tool.metadata.id) {
    throw new ValidationError(
      `tool manifest id '${manifest.id}' does not match runtime tool id '${tool.metadata.id}'`,
    );
  }

  const manifestNames = new Set(manifest.commands.map((c) => c.name));
  const toolNames = new Set(tool.commands.map((c) => c.name));

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
}
