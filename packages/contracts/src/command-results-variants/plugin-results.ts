import type { ToolProvenance } from '@opensip-cli/core';

/**
 * Identity of a discovered plugin (exposed by `plugin list`).
 * Mirrors the `DiscoveredPlugin` shape from core, but kept here as a
 * separate contract type so the CLI ↔ plugin-result boundary is
 * stable independently of core's internal representation.
 */
export interface PluginInfo {
  readonly domain: string;
  readonly namespace: string;
  readonly pluginType: 'package' | 'file';
}

/**
 * Per-package status from `plugin sync`. `installed: true` means the
 * `npm install` succeeded; `false` means it failed (the message is
 * carried in the surrounding `errors[]`).
 */
export interface SyncEntry {
  readonly domain: string;
  readonly package: string;
  readonly installed: boolean;
}

/**
 * Discriminated union — one variant per `plugin` subcommand. Each
 * variant has its own top-level `type` literal, matching the rest of
 * `CommandResult` (`'run-presentation'`, `'list-checks'`, …).
 * Consumers switch on `result.type` directly; producer/consumer drift
 * surfaces at compile time.
 */
export type PluginResult =
  | {
      type: 'plugin-list';
      /**
       * Ordered plugin domains to render, sourced from registered tool
       * `pluginLayout` descriptors plus the built-in Tool plugin domain.
       */
      domains: readonly string[];
      plugins: readonly PluginInfo[];
      totalCount: number;
      /**
       * Provenance of the tools admitted through the launch compatibility
       * gate this run (source + identity + `manifestHash`). Additive — a
       * parallel section to the discovered-plugin list, sourced from the
       * per-run provenance holder, not from a disk re-scan. Empty array
       * when no bootstrap ran (e.g. isolated unit tests).
       */
      toolProvenance: readonly ToolProvenance[];
    }
  | {
      type: 'plugin-add';
      packageName: string;
      success: boolean;
      error?: string;
    }
  | {
      type: 'plugin-remove';
      packageName: string;
      success: boolean;
      error?: string;
    }
  | {
      type: 'plugin-sync';
      synced: readonly SyncEntry[];
      success: boolean;
      errors?: readonly string[];
    };
