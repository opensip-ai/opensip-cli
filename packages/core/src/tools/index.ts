/**
 * @fileoverview Tool plugin barrel.
 *
 * Public API for the Tool contract — the kernel-level plugin shape
 * that fitness, simulation, and future tools implement.
 */

export type {
  Tool,
  ToolMetadata,
  ToolCommandDescriptor,
  ToolCliContext,
  GateCompareResult,
  SignalDeliveryResult,
  ScaffoldContext,
  ScaffoldFile,
  ToolPluginExports,
  ToolSessionRecord,
  ToolSessionReplayContribution,
  LiveViewRenderer,
  LiveViewContext,
  ToolRunSessionInput,
  RecordedToolRunSession,
  ToolRunSessions,
  ToolExtensionPoints,
  // Typed host planes (hygiene plan Phase 0)
  HostGovernance,
  HostAudit,
  HostEntitlements,
} from './types.js';
export { UnknownLiveViewError } from './types.js';
export { TOOL_CONTRACT_VERSION } from './types.js';
export { ToolRegistry } from './registry.js';
// Static tool-plugin manifest + the plugin-API epoch + provenance types
// (launch raw-vs-admitted contract).
export { PLUGIN_API_VERSION } from './manifest.js';
// Command-plane types (launch, §5.4): the declarative command surface a
// tool exports for the host to mount, plus the CommonFlagKey key type (the pure
// type lives in core; the Commander-touching applyCommonFlags runtime stays in
// contracts). Re-exported by @opensip-cli/contracts for the public surface.
export { defineCommand, COMMON_FLAG_KEYS, RAW_STREAM_REASONS } from './command-spec.js';
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
  ToolProvenance,
  ToolSource,
} from './manifest.js';
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
export type { CompatibilityVerdict } from './compatibility.js';
// Load-time manifest⇔Tool drift guard.
export { assertManifestMatchesTool } from './manifest-assert.js';
export {
  TOOL_LONG_IDS,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_IDS,
  TOOL_SHORT_TO_LONG,
  isToolLongId,
  isToolShortId,
} from './ids.js';
export type { ToolLongId, ToolShortId } from './ids.js';
