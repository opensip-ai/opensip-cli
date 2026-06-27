// Tools — kernel-level Tool plugin contract.
// (discoverToolPackages and friends live under plugins/ and are
// re-exported above; the Tool / Registry types are tool-shape, not
// plugin-discovery-shape, hence the separate barrel.)
export {
  ToolRegistry,
  UnknownLiveViewError,
  TOOL_CONTRACT_VERSION,
  createTool,
  createToolScope,
  defineTool,
  deriveCommandsFromSpecs,
  resolveToolCommands,
  resolveToolCommandNames,
  applyToolContributeScope,
  resolveToolHooks,
  deriveRunOutcome,
  inferStoredRunOutcome,
} from './tools/index.js';
export type {
  ReportFailureDetail,
  ReportFailureLogDetail,
  ResolvedReportFailure,
} from './tools/report-failure.js';
export type {
  CreateToolInput,
  DefineToolInput,
  ResolvedToolHooks,
  Tool,
  ToolMetadata,
  ToolCommandDescriptor,
  ToolConfigContribution,
  ToolCliContext,
  GateCompareResult,
  SignalDeliveryResult,
  ScaffoldContext,
  ScaffoldFile,
  ToolPluginExports,
  ToolSessionRecord,
  ToolSessionReplayContribution,
  // Preferred place for new/rare/future tool capabilities (see JSDoc on the type).
  // This is the official evolution path for the Tool contract instead of
  // adding more top-level optionals to `Tool`.
  ToolExtensionPoints,
  LiveViewRenderer,
  LiveViewContext,
  ToolSessionContribution,
  ToolRunCompletion,
  RecordedToolRunSession,
  ToolRunSessions,
  ToolRunOutcome,
  // Typed host planes (host-planes-scope-seams-hygiene Phase 0): public so Cloud + third-party tools
  // can type against the bag on ToolCliContext without subpath imports. OSS flexibility via toolState.
  HostGovernance,
  HostAudit,
  HostEntitlements,
} from './tools/index.js';
// Static tool-plugin manifest + the plugin-API epoch + provenance types
// (launch raw-vs-admitted contract). Re-exported by @opensip-cli/
// contracts for the public surface.
export { MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION } from './tools/index.js';
export type {
  RawToolPluginManifest,
  ToolPluginManifest,
  ToolCommandManifest,
  ManifestOptionDescriptor,
  ToolProvenance,
  ToolResourceClass,
  ToolResourceRequirement,
  ToolSource,
} from './tools/index.js';
// ADR-0054 M4-E: the serializable config descriptor a tool declares in its
// manifest (the coarse host pass for external tools; the deep Zod pass runs in
// the worker). Re-exported by @opensip-cli/contracts for the public surface.
export type {
  JsonSchemaPrimitiveType,
  JsonSchemaNode,
  JsonSchemaObject,
  ToolConfigManifestDescriptor,
} from './tools/index.js';
// Command-plane types (launch, §5.4): the declarative CommandSpec a tool
// exports for the host to mount, plus the pure CommonFlagKey key type. The
// Commander-touching applyCommonFlags runtime stays in @opensip-cli/contracts,
// which re-exports CommonFlagKey from here. Re-exported by contracts.
export {
  assertCommandSpec,
  defineCommand,
  defineNestedCommand,
  definePrimaryCommand,
  validateCommandSpec,
  COMMON_FLAG_KEYS,
  RAW_STREAM_REASONS,
} from './tools/index.js';
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
} from './tools/index.js';
// Capability domain model (launch, §5.3): the data shape a tool
// uses to declare an extension point it owns. The scope-owned runtime
// registry is exported from ./plugins/index.js below. Re-exported by
// @opensip-cli/contracts for the public surface.
export { isCapabilityValidator, isStructuralContributionSchema } from './tools/index.js';
export type {
  CapabilityDomainSpec,
  CapabilityContributionKind,
  CapabilityDiscoveryDescriptor,
  CapabilityDiscoveryMode,
  CapabilityCoContribution,
  CapabilityValidator,
  StructuralContributionSchema,
  ToolCapabilityDeclaration,
} from './tools/index.js';
// The single pure compatibility gate shared by the bundled + external
// admission paths. Re-exported by @opensip-cli/contracts.
export { checkCompatibility } from './tools/index.js';
export type { CompatibilityVerdict } from './tools/index.js';
// Load-time manifest⇔Tool drift guard.
export { assertManifestMatchesTool } from './tools/index.js';
// Tool identity — single source of truth (ADR tool-identity-single-source).
export {
  buildToolIdentityIndex,
  resolveToolFilterToLayoutKey,
  validateToolIdentity,
} from './tools/index.js';
export type {
  ToolIdentity,
  ToolIdentityBinding,
  ToolIdentityIndex,
  NestedCommandSpecDraft,
  PrimaryCommandSpecDraft,
  ToolCommandSpecInput,
} from './tools/index.js';
export {
  TOOL_LONG_IDS,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_IDS,
  TOOL_SHORT_TO_LONG,
  isBundledToolShortId,
  isRegisteredToolId,
  isToolLongId,
  isToolShortId,
  registeredToolShortIds,
} from './tools/index.js';
export type { BundledToolShortId, ToolLongId, ToolShortId } from './tools/index.js';
// (isRegisteredToolId / registeredToolShortIds re-exported above via tools barrel;
//  they live in tools/registered-ids.ts to keep tools/ids.ts a cycle-free leaf.)
