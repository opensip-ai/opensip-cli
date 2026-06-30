/**
 * @fileoverview Tool plugin barrel.
 *
 * Public API for the Tool contract — the kernel-level plugin shape
 * that fitness, simulation, and future tools implement.
 */

export type {
  ReportFailureDetail,
  ReportFailureLogDetail,
  ResolvedReportFailure,
} from './report-failure.js';
export type {
  Tool,
  ToolMetadata,
  ToolCommandDescriptor,
  ToolCliContext,
  GateCompareResult,
  SignalDeliveryResult,
  ToolPluginExports,
  ToolSessionRecord,
  ToolSessionReplayContribution,
  LiveViewRenderer,
  LiveViewContext,
  ToolSessionContribution,
  ToolRunCompletion,
  RecordedToolRunSession,
  ToolRunSessions,
  ToolExtensionPoints,
  // Typed host planes (hygiene plan Phase 0)
  HostGovernance,
  HostAudit,
  HostEntitlements,
} from './types.js';
export type { ScaffoldContext, ScaffoldFile } from './scaffold.js';
export { UnknownLiveViewError } from './types.js';
export { TOOL_CONTRACT_VERSION } from './types.js';
export { ToolRegistry } from './registry.js';
// Static tool-plugin manifest + the plugin-API epoch + provenance types
// (launch raw-vs-admitted contract).
export { MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION } from './manifest.js';
// Command-plane types (launch, §5.4): the declarative command surface a
// tool exports for the host to mount, plus the CommonFlagKey key type (the pure
// type lives in core; the Commander-touching applyCommonFlags runtime stays in
// contracts). Re-exported by @opensip-cli/contracts for the public surface.
export { COMMON_FLAG_KEYS, RAW_STREAM_REASONS, commandProducesVerdict } from './command-spec.js';
// The runtime admission guard for the command contract lives beside the types
// in ./command-spec-validate.ts (kept separate so each file stays one concern).
export { assertCommandSpec, defineCommand, validateCommandSpec } from './command-spec-validate.js';
export { defineNestedCommand, definePrimaryCommand } from './command-spec-draft.js';
export type {
  NestedCommandSpecDraft,
  PrimaryCommandSpecDraft,
  ToolCommandSpecInput,
} from './command-spec-draft.js';
export { validateToolIdentity } from './identity.js';
export type { ToolIdentity } from './identity.js';
export { buildToolIdentityIndex, resolveToolFilterToLayoutKey } from './identity-index.js';
export type { ToolIdentityBinding, ToolIdentityIndex } from './identity-index.js';
export type {
  CommandSpec,
  OptionSpec,
  ArgSpec,
  CommandHandler,
  CommandContext,
  CommandOutputMode,
  CommandScopeRequirement,
  CommonFlagKey,
  RawStreamReason,
} from './command-spec.js';
export type {
  RawToolPluginManifest,
  ToolPluginManifest,
  ToolCommandManifest,
  ManifestOptionDescriptor,
  ToolProvenance,
  ToolResourceClass,
  ToolResourceRequirement,
  ToolSource,
} from './manifest.js';
// ADR-0054 M4-E: the serializable, JSON-Schema-shaped config descriptor a tool
// declares in its manifest (the coarse host pass for external tools).
export type {
  JsonSchemaPrimitiveType,
  JsonSchemaNode,
  JsonSchemaObject,
  ToolConfigManifestDescriptor,
} from './manifest-config.js';
// Capability domain model (launch, §5.3): the data shape a tool
// uses to declare an extension point it owns. The runtime registry lives
// in `plugins/capability-registry.ts`.
export { isCapabilityValidator, isStructuralContributionSchema } from './capability.js';
export type {
  CapabilityDomainSpec,
  CapabilityContributionKind,
  CapabilityDiscoveryDescriptor,
  CapabilityDiscoveryMode,
  CapabilityCoContribution,
  CapabilityValidator,
  StructuralContributionSchema,
  ToolCapabilityDeclaration,
  ToolConfigContribution,
} from './capability.js';
// The single pure compatibility gate shared by the bundled + external
// admission paths.
export { checkCompatibility } from './compatibility.js';
export type { CompatibilityVerdict, PluginApiCompatibilityRange } from './compatibility.js';
// Load-time manifest⇔Tool drift guard.
export { assertManifestMatchesTool } from './manifest-assert.js';
export {
  deriveCommandsFromSpecs,
  resolveToolCommands,
  resolveToolCommandNames,
} from './derive-commands-from-specs.js';
export { renderGateCompareLines } from './gate-compare-render.js';
export type { GateCompareRenderOptions } from './gate-compare-render.js';
export { defineTool } from './define-tool.js';
export type { DefineToolInput } from './define-tool.js';
export { createTool } from './create-tool.js';
export type { CreateToolInput } from './create-tool.js';
export { createToolScope } from './create-tool-scope.js';
export { applyToolContributeScope, resolveToolHooks } from './resolve-tool-hooks.js';
export type { ResolvedToolHooks } from './resolve-tool-hooks.js';
export {
  TOOL_LONG_IDS,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_IDS,
  TOOL_SHORT_TO_LONG,
  isBundledToolShortId,
  isToolLongId,
  isToolShortId,
} from './ids.js';
export type { BundledToolShortId, ToolLongId, ToolShortId } from './ids.js';
export type { ToolRunOutcome } from './run-outcome.js';
export { deriveRunOutcome, inferStoredRunOutcome } from './run-outcome.js';
export { isRegisteredToolId, registeredToolShortIds } from './registered-ids.js';
