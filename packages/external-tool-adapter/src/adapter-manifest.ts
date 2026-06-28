/**
 * @fileoverview Manifest derivation from the built adapter `Tool` (ADR-0090
 * §4.3 / §4.8 / ADR-0092) — the `config` namespace claim and the `requires`
 * resource needs.
 *
 * An installed adapter's static `package.json#opensipTools` must mirror its
 * runtime, and the generator (`build-tool-command-manifests.mjs`) plus a per-tool
 * `--check` parity gate keep them in lock-step. `deriveAdapterManifestCommands`
 * (a sibling) derives the command shells; the helpers here derive the remaining
 * adapter-shaped manifest fields from data the substrate STAMPS on the built Tool
 * ({@link AdapterToolMarkers}) — the substrate's own data, never a core `Tool`
 * concept.
 */

import type { NetworkPosture } from './types.js';
import type { Tool, ToolConfigManifestDescriptor } from '@opensip-cli/core';

/**
 * The adapter-substrate markers {@link defineExternalToolAdapter} stamps on the
 * Tool it returns. Kept off the core `Tool` contract (an adapter concept, not a
 * kernel one); the substrate reads them back here to derive manifest fields.
 */
export interface AdapterToolMarkers {
  /** The declared network posture (ADR-0092), drives `requires` derivation. */
  readonly adapterNetwork?: NetworkPosture;
  /** The coarse config descriptor the adapter claims, or `undefined` for a custom config. */
  readonly adapterConfigManifest?: ToolConfigManifestDescriptor;
}

/** Read the stamped config descriptor, or `undefined` when the adapter uses a custom config. */
export function adapterConfigManifestOf(tool: Tool): ToolConfigManifestDescriptor | undefined {
  return (tool as Tool & AdapterToolMarkers).adapterConfigManifest;
}

/**
 * Derive the static `opensipTools.config` descriptor for an adapter — the coarse
 * namespace claim the host validates a `<tool>:` block against pre-fork. Returns
 * `undefined` for an adapter whose config cannot be coarsely serialized (a custom
 * `spec.config`), which defers ALL of its config validation to the worker deep
 * pass (ADR-0054 M4-E); the generator then omits the `config` key.
 */
export function deriveAdapterConfigManifest(tool: Tool): ToolConfigManifestDescriptor | undefined {
  return adapterConfigManifestOf(tool);
}
