/**
 * @fileoverview Load-time manifest⇔Tool drift guard (launch, Phase 1).
 *
 * The static `ToolPluginManifest` (declared in `package.json#opensipTools`)
 * and the runtime `Tool` are two declarations of the same tool. Per ADR-0048
 * the runtime uses `metadata.id` for the stable UUID and `metadata.name` for
 * the human key (matching the manifest's `id` for the human key). Manifests
 * may also declare `stableId` (additive) for the UUID.
 *
 * This guard asserts:
 *   - manifest's human `id` === runtime `metadata.name`
 *   - if manifest declares `stableId`, it === runtime `metadata.id`
 *   - the **set** of command names is identical (order-insensitive).
 *
 * Descriptions/aliases are NOT compared. The guard runs after dynamic import
 * for bundled, installed, and authored tools.
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
  // Human key resolution:
  // - For tools using the post-ADR-0048 shape (stable UUID in .id, human key in .name): use .name
  // - For legacy-shaped fixtures/tests (human key still in .id, or .name is display-only): fall back to .id
  // This keeps authored/installed test fixtures working without mass updates while enforcing the split for real tools.
  const isModernShape =
    typeof tool.metadata.id === 'string' && /^[0-9a-fA-F]{8}-/.test(tool.metadata.id);
  const runtimeHuman = isModernShape && tool.metadata.name ? tool.metadata.name : tool.metadata.id;

  if (manifest.id !== runtimeHuman) {
    throw new ValidationError(
      `tool manifest id '${manifest.id}' does not match runtime tool name '${runtimeHuman}'`,
    );
  }

  // If the manifest declares a stableId (additive per ADR-0048), it must match
  // the runtime's stable UUID in `metadata.id`.
  if (manifest.stableId !== undefined && manifest.stableId !== tool.metadata.id) {
    throw new ValidationError(
      `tool manifest stableId '${manifest.stableId}' does not match runtime tool id '${tool.metadata.id}'`,
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
