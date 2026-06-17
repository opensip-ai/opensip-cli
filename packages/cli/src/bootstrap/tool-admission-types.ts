import type { ToolPluginManifest, ToolProvenance } from '@opensip-cli/core';

/**
 * The outcome of admitting a tool — the recorded `ToolProvenance` plus the
 * loaded `ToolPluginManifest`. The manifest is returned (not re-read) so the
 * register step can run the drift guard against the imported runtime and seed
 * the per-run capability registry without a second filesystem read.
 */
export interface ToolAdmission {
  readonly provenance: ToolProvenance;
  readonly manifest: ToolPluginManifest;
}
