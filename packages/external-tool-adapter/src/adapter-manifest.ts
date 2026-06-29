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
 * concept:
 *
 *   - {@link deriveAdapterManifestRequires} forward-maps the declared `network`
 *     posture (ADR-0092) onto `opensipTools.requires`: `subprocess` + `filesystem`
 *     ALWAYS (every adapter `execFile`s a binary and reads/writes the project +
 *     artifact store), plus `network` WHEN the posture is not `local-only`. This is
 *     the §4.8 "honest labeling" mapping the `types.ts` contract claims — derived,
 *     not hand-authored, so flipping an adapter to `networked` produces a `--check`
 *     drift the gate catches.
 *   - {@link deriveAdapterConfigManifest} returns the coarse config descriptor the
 *     adapter claims (its namespace + `binaries` block) so the host pre-fork pass
 *     recognizes the namespace and an operator's `<tool>:` block no longer bricks.
 */

import type { NetworkPosture } from './types.js';
import type {
  Tool,
  ToolConfigManifestDescriptor,
  ToolResourceRequirement,
} from '@opensip-cli/core';

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

/** Read the stamped network posture; defaults to `'local-only'` (the safe, no-network posture). */
export function adapterNetworkOf(tool: Tool): NetworkPosture {
  return (tool as Tool & AdapterToolMarkers).adapterNetwork ?? 'local-only';
}

/** Read the stamped config descriptor, or `undefined` when the adapter uses a custom config. */
export function adapterConfigManifestOf(tool: Tool): ToolConfigManifestDescriptor | undefined {
  return (tool as Tool & AdapterToolMarkers).adapterConfigManifest;
}

/**
 * Derive `opensipTools.requires` from the adapter's network posture (ADR-0092
 * §4.8). `subprocess` + `filesystem` are unconditional; `network` is added only
 * when the posture is `networked`/`auth-required`. Pure — the manifest generator
 * writes the result and the per-tool `--check` parity gate fails on drift.
 */
export function deriveAdapterManifestRequires(tool: Tool): readonly ToolResourceRequirement[] {
  const requires: ToolResourceRequirement[] = [
    {
      resource: 'subprocess',
      reason: `Executes the user-installed ${tool.metadata.name} binary via execFile (no shell)`,
    },
    {
      resource: 'filesystem',
      reason:
        'Reads the project working tree and writes the raw scan artifact under .runtime/artifacts',
    },
  ];
  if (adapterNetworkOf(tool) !== 'local-only') {
    requires.push({
      resource: 'network',
      reason: `Performs network I/O for the ${adapterNetworkOf(tool)} scanner posture`,
    });
  }
  return requires;
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
