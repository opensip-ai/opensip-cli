import type {
  CliDiagnostic,
  LanguageRegistry,
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
}
