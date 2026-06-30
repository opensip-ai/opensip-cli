/**
 * host-declarations — the document-level config blocks owned by the host
 * (the config package itself), not by any Tool plugin.
 *
 * Each tool contributes a namespaced {@link ToolConfigDeclaration}
 * (`fitness`/`graph`/`simulation`) that the composer strict-validates. The
 * tool-agnostic blocks — `cli`, `dashboard`, `schemaVersion`, `plugins`, and
 * (from Phase 1) `targets`/`globalExcludes`/`checkOverrides` — are owned by no
 * tool. They are returned here as `ToolConfigDeclaration`s and composed BESIDE
 * the tool declarations (the composer is namespace-agnostic), turning the
 * previously-`.catchall`-tolerated top-level keys into claimed, strict
 * namespaces (ADR-0023).
 *
 * `schemaVersion` is claimed as a permissive top-level `number` so the
 * composed document does not reject it — but the version-COMPAT decision
 * (`readConfigSchemaVersion` + `checkSchemaCompat`) stays in `core`, run in the
 * pre-action gate BEFORE validation (ADR-0023 §Amendment).
 */

import { z } from 'zod';

import { cliConfigSchema } from './cli-config.js';
import { dashboardConfigSchema } from './dashboard.js';
import { suitesConfigSchema } from './suites.js';
import {
  checkOverridesSchema,
  createPluginsConfigSchema,
  globalExcludesSchema,
  targetsRecordSchema,
  type PluginConfigKeyDeclaration,
} from './targeting.js';
import { toolsConfigSchema } from './tools-config.js';

import type { ToolConfigDeclaration } from '../declaration.js';

/**
 * Options for {@link hostConfigDeclarations}.
 *
 * The host's document-level declarations are mostly static, but the `plugins.*`
 * namespace is dynamic — a plugin may contribute its own typed config keys. The
 * composition root collects those and passes them here so the composed schema
 * validates declared plugin keys strictly.
 */
export interface HostConfigDeclarationOptions {
  /**
   * Per-plugin config-key declarations discovered for this run. Each becomes a
   * strictly-validated key under the `plugins.<id>` namespace. Omitted (or
   * empty) when no plugin contributes config.
   */
  readonly pluginConfigKeys?: readonly PluginConfigKeyDeclaration[];
}

/**
 * The host's document-level declarations. Grows in Phase 1 (targeting).
 *
 * Returned as a fresh array per call (no shared mutable state); the
 * composition root concatenates these with the per-tool declarations.
 */
export function hostConfigDeclarations(
  options: HostConfigDeclarationOptions = {},
): readonly ToolConfigDeclaration[] {
  return [
    { namespace: 'cli', schema: cliConfigSchema },
    { namespace: 'dashboard', schema: dashboardConfigSchema },
    // Permissive: core owns version-compat; the schema only ensures a present
    // value is a positive integer, never rejecting an absent one.
    { namespace: 'schemaVersion', schema: z.number().int().min(1) },
    // Shared two-layer scope model — three top-level keys, registered
    // separately so the composed document matches the existing YAML exactly (no
    // `targeting:` wrapper key; no rename).
    { namespace: 'targets', schema: targetsRecordSchema },
    { namespace: 'globalExcludes', schema: globalExcludesSchema },
    { namespace: 'checkOverrides', schema: checkOverridesSchema },
    { namespace: 'suites', schema: suitesConfigSchema },
    { namespace: 'tools', schema: toolsConfigSchema },
    {
      namespace: 'plugins',
      schema: createPluginsConfigSchema(options.pluginConfigKeys),
    },
  ];
}
