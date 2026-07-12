import type { PolicyAuditCollector } from './policy-audit.js';
import type { StartupTimingEvent } from './startup-timing.js';
import type { ResolvedTrustPolicy } from '@opensip-cli/config';
import type {
  CliDiagnostic,
  LanguageRegistry,
  RuntimeCommandInventory,
  ToolPluginManifest,
  ToolProvenance,
  ToolRegistry,
} from '@opensip-cli/core';

/** Per-invocation bootstrap inputs captured in the pre-action hook closure. */
export interface PreActionRuntime {
  readonly languages: LanguageRegistry;
  readonly tools: ToolRegistry;
  readonly manifests: readonly ToolPluginManifest[];
  readonly provenance: readonly ToolProvenance[];
  readonly bootstrapDiagnostics: readonly CliDiagnostic[];
  readonly startupTimings?: readonly StartupTimingEvent[];
  readonly trustPolicy: ResolvedTrustPolicy;
  readonly policyAudit: PolicyAuditCollector;
  /**
   * Plain host+Tool command inventory projected once at composition-root
   * startup. Stored on each {@link RunScope} so MCP runtime wiring never
   * retains live CommandSpecs or CLI closures.
   */
  readonly runtimeCommands?: RuntimeCommandInventory;
}
