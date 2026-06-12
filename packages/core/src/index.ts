// @fitness-ignore-file file-length-limit -- the @opensip-cli/core public-API re-export barrel: pure re-exports that grow with the kernel surface; splitting it would fragment the one import surface every package consumes.
// Types — internal signal (shared across tools)
export type {
  Signal,
  SignalSeverity,
  SignalCategory,
  CreateSignalInput,
  FixHint,
} from './types/signal.js';
export { createSignal, isErrorSeverity, isErrorSignal } from './types/signal.js';

// Severity & Signal policy (north-star §5.9, release 2.13.0). One home for
// author→wire severity mapping + the override clamp + the gate's error/warning
// predicate, plus the generic identity-stamping factory `createSignalFromViolation`
// (so tools stamp source/ruleId/severity instead of retyping them).
export { SeverityPolicy } from './lib/severity-policy.js';
export type { AuthorSeverity } from './lib/severity-policy.js';
// Host-owned findings verdict policy (ADR-0035): the reserved
// failOnErrors/failOnWarnings gate, its pure predicate, and the per-tool resolver.
export {
  HOST_VERDICT_POLICY_FALLBACK,
  policyPasses,
  resolveVerdictPolicy,
  DEFAULT_FAIL_ON_DEGRADED,
  resolveFailOnDegraded,
} from './lib/verdict-policy.js';
export type { VerdictPolicy } from './lib/verdict-policy.js';
// Host-owned baseline/ratchet plane (ADR-0036): the per-tool fingerprint
// strategy primitive, the host default identity, and the stamp helper.
export { defaultFingerprintStrategy, stampFingerprints } from './baseline/fingerprint-strategy.js';
export type { FingerprintStrategy } from './baseline/fingerprint-strategy.js';
export { createSignalFromViolation } from './signals/create-signal-from-violation.js';
export type { ViolationInput } from './signals/create-signal-from-violation.js';
// Cloud signal egress envelope (ADR-0008)
export type { SignalBatch, RepoIdentity, BuildSignalBatchInput } from './types/signal-batch.js';
export { buildSignalBatch, MAX_SIGNALS_PER_BATCH } from './types/signal-batch.js';
// Cloud signal sink seam (ADR-0008)
export type { SignalSink, EmitResult } from './signals/signal-sink.js';
export { noopSignalSink } from './signals/signal-sink.js';
// Inline suppression primitive (ADR-0014) — shared `@x-ignore-*` machinery
export { filterSignalsBySuppressions, scanSuppressionDirectives } from './signals/suppress.js';
export type {
  SuppressionKeywords,
  SuppressionLocation,
  SuppressionRequest,
  SuppressionMatch,
  SuppressionResult,
  SuppressionScan,
} from './signals/suppress.js';
export { COMMENT_OPENERS, stripCommentOpener } from './signals/comment-openers.js';

// Runtime — live-run progress transport seam (ADR-0016). Generic over the event
// type so the kernel never names cli-ui's concrete ProgressEvent.
export { createInProcessTransport } from './runtime/in-process-transport.js';
export {
  createSubprocessProgressRun,
  runOffThreadOrInProcess,
} from './runtime/subprocess-transport.js';
export type {
  ProgressTransport,
  ProgressRun,
  ProgressJob,
  SubprocessJobDescriptor,
  WorkerMessage,
} from './runtime/progress-transport.js';

// Languages — cross-language adapter API
export * from './languages/index.js';

// Project config resolution
export { PROJECT_CONFIG_FILENAME, resolveProjectConfigPath } from './config-resolution.js';

// Plugins
export {
  discoverPlugins,
  readProjectPluginsList,
  resolvePackageEntryPoint,
  discoverToolPackages,
  discoverToolPackagesFromAnchors,
  readToolPackageMetadata,
  discoverPackagesByMarker,
  discoverPackagesByDeclaredKind,
  discoverPackagesInNodeModules,
  isMarkerKind,
  readMarkerKind,
  readDeclaredKind,
  MARKER_KINDS,
  discoverScopedPackages,
  discoverCapabilityContributions,
  isRecord,
  isStringArray,
  hasPackageJson,
  resolvePackageDir,
  registerRecipesFromMod,
  loadPlugin,
  loadAllPlugins,
  resolveScopes,
  VALID_NPM_SCOPE_REGEX,
  loadToolManifest,
  admitTool,
  discoverAuthoredToolSidecars,
  registerCapabilityDomainsFromManifest,
  PROJECT_LOCAL_MANIFEST_FILE,
  CapabilityRegistry,
  createCapabilityRegistry,
  currentCapabilityRegistry,
  loadCapabilityDomain,
} from './plugins/index.js';
export type {
  AdmissionResult,
  AuthoredToolCandidate,
  CapabilityRegistrar,
  LoadCapabilityDomainOptions,
  PluginLayout,
  DiscoveredPlugin,
  LoadedPlugin,
  PluginLoadResult,
  LangPluginExports,
  PluginExports,
  PackageEntryResolution,
  ToolPackageDiscoveryOptions,
  ToolDiscoverySource,
  DiscoveredToolPackage,
  ToolPackageMetadata,
  MarkerKind,
  MarkerDiscoveryOptions,
  DiscoveredMarkerPackage,
  DiscoveredDeclaredPackage,
  DiscoveredScopedPackage,
  DiscoverScopedPackagesOptions,
  CapabilityDiscoveryPreferences,
  RawCapabilityContribution,
  CapabilityDiscoveryDiagnostic,
  DiscoverCapabilityContributionsOptions,
  RegisterRecipesOptions,
  RegisterRecipesResult,
  RegisterCtx,
  RegisteredCounts,
  RegisterExportsFn,
} from './plugins/index.js';

// Tools — kernel-level Tool plugin contract.
// (discoverToolPackages and friends live under plugins/ and are
// re-exported above; the Tool / Registry types are tool-shape, not
// plugin-discovery-shape, hence the separate barrel.)
export { ToolRegistry, UnknownLiveViewError } from './tools/index.js';
export type {
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
  LiveViewRenderer,
} from './tools/index.js';
// Static tool-plugin manifest + the plugin-API epoch + provenance types
// (release 3.0.0 raw-vs-admitted contract). Re-exported by @opensip-cli/
// contracts for the public surface.
export { PLUGIN_API_VERSION } from './tools/index.js';
export type {
  RawToolPluginManifest,
  ToolPluginManifest,
  ToolCommandManifest,
  ToolProvenance,
  ToolSource,
} from './tools/index.js';
// Command-plane types (release 2.11.0, §5.4): the declarative CommandSpec a tool
// exports for the host to mount, plus the pure CommonFlagKey key type. The
// Commander-touching applyCommonFlags runtime stays in @opensip-cli/contracts,
// which re-exports CommonFlagKey from here. Re-exported by contracts.
export { defineCommand, COMMON_FLAG_KEYS, RAW_STREAM_REASONS } from './tools/index.js';
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
// Capability domain model (release 2.10.0, §5.3): the data shape a tool
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
export {
  TOOL_LONG_IDS,
  TOOL_LONG_TO_SHORT,
  TOOL_SHORT_IDS,
  TOOL_SHORT_TO_LONG,
  isToolLongId,
  isToolShortId,
} from './tools/index.js';
export type { ToolLongId, ToolShortId } from './tools/index.js';

// Recipes — generic recipe registry shared by fitness + simulation.
export { RecipeRegistry } from './recipes/registry.js';
export type {
  RecipeBase,
  RecipeRegisterOptions,
  RecipeRegistryOptions,
} from './recipes/registry.js';

// Recipes — generic selector union + resolver (selection half of the
// substrate; execution stays tool-owned).
export { resolveSelector } from './recipes/selector.js';
export type {
  RecipeSelector,
  ExplicitSelector,
  AllSelector,
  TagsSelector,
  PatternSelector,
  ResolveSelectorOptions,
} from './recipes/selector.js';
// Recipes — per-unit config-override accessors + map type.
export {
  getUnitConfig,
  setCurrentRecipeUnitConfig,
  clearCurrentRecipeUnitConfig,
} from './recipes/unit-config.js';
export type { RecipeUnitConfigMap } from './recipes/unit-config.js';

// Generic `Registry<T>` — the unified base for every registry in the
// workspace. Replaces the ten registry classes catalogued in the
// runscope+registry plan's Phase 0. See `lib/registry.ts` for the
// full design rationale + the closed `DuplicatePolicy` union.
//
// `Registerable` is the minimum shape every registry item must
// satisfy: `{ id, name, tags? }`. The historical `IdNameTagRegistry`
// has been deleted; consumers use `Registry<T>` directly with
// `duplicatePolicy: 'silent-skip'` + `nameCollisionMode: 'throw'`
// for the same dual-key semantics.
export { Registry } from './lib/registry.js';
export type {
  DuplicatePolicy,
  Registerable,
  RegistryOptions,
  RegisterCallOptions,
} from './lib/registry.js';

// RunScope — per-invocation execution scope. Owns the lifecycle of
// every singleton the codebase previously hung on module-level state
// (logger, caches, registries, recipe-config slot, project context,
// datastore thunk). See `lib/run-scope.ts` for the AsyncLocalStorage
// seam and the two-copies-of-fitness hazard resolution.
export {
  RunScope,
  runWithScope,
  runWithScopeSync,
  enterScope,
  currentScope,
} from './lib/run-scope.js';
export type { RunScopeOptions } from './lib/run-scope.js';
// The Tool-contract scope types live in the leaf `scope-types.ts` so the
// `Tool` contract can depend on them without naming the concrete `RunScope`
// (breaks the RunScope⟷Tool type cycle; audit 2026-05-29 M4). Source them
// here directly from the leaf.
export type {
  RecipeUnitConfigSlot,
  DataStoreThunk,
  ToolScope,
  ScopeContribution,
  ResolvedToolConfig,
  TargetResolver,
  TargetView,
} from './lib/scope-types.js';

// Lib — errors + Result pattern
export {
  ToolError,
  ValidationError,
  NotFoundError,
  SystemError,
  TimeoutError,
  NetworkError,
  ConfigurationError,
  PluginIncompatibleError,
  UnknownCapabilityDomainError,
  CapabilitySchemaMismatchError,
} from './lib/errors.js';
export { ok, err, tryCatchAsync, tryCatch } from './lib/errors.js';
export type { Result, ToolErrorCode, ToolErrorOptions } from './lib/errors.js';

// Lib — logger.
//
// Production callers should import the typed `logger` singleton +
// helper functions; `LoggerImpl` is exported for tests (and tools
// that need an isolated logger) — advanced / discouraged for
// general use, see the file-level docstring on lib/logger.ts.
// `getRunId()` free function was removed in Item 2 — read
// `currentScope()?.runId` instead. The instance methods
// `LoggerImpl.{get,set}RunId` survive for isolated-instance test use.
export { logger, LoggerImpl, configureLogger } from './lib/logger.js';
export type { Logger, LogLevel, LoggerOptions, RunIdProvider } from './lib/logger.js';

// Lib — telemetry (tracing). The kernel sibling of `logger`: a thin seam over
// the OpenTelemetry *API* (`@opentelemetry/api`) only. No-op until an SDK
// registers a global provider at the application boundary (the CLI). Tools emit
// spans via `withSpan` and reach span types through this barrel so they never
// import `@opentelemetry/api` directly — the kernel is the single seam.
export { getTracer, withSpan, withSpanAsync, currentTraceparent } from './lib/telemetry.js';
export type { Span, Attributes, Tracer } from '@opentelemetry/api';

// Lib — environment registry (north-star §5.12, release 2.12.0). The kernel
// observability primitive that governs the env surface: a tool/host declares an
// `EnvVarSpec` (canonical name, aliases, coercion, default, docs, deprecation) and
// every env read flows through `EnvRegistry.get`. Reading `process.env` inside
// this primitive is the one sanctioned site; the `env-via-registry` guardrail
// fails CI on raw reads elsewhere. The immutable definition table lets a static
// instance serve the pre-scope readers (theme, graph heap-preflight).
export { EnvRegistry } from './lib/env-registry.js';
export type { EnvVarSpec, EnvDeprecation, EnvReadResult } from './lib/env-registry.js';

// Lib — run diagnostics (north-star §5.10, release 2.12.0). The shared,
// JSON-emittable diagnostics vocabulary carried on a `CommandOutcome`, produced
// by the scope-owned `DiagnosticsBus`. Types DEFINED here (the bus that produces
// them is here; contracts re-exports the types for `CommandOutcome`).
export { DiagnosticsBus } from './lib/diagnostics-bus.js';
export type {
  RunDiagnostics,
  DiagnosticEvent,
  DiagnosticPhase,
  DiagnosticLevel,
} from './lib/run-diagnostics.js';

// Lib — permissive YAML reader (returns undefined on missing/malformed
// files). Used by plugin-discovery sites that need to peek at a single
// field of opensip-cli.config.yml without dragging in a Zod schema.
// Advanced / discouraged for general use — tools that need structured
// parse errors should use `readYamlFileOrThrow` instead, or build their
// own dedicated loader (see fitness's targets/loader.ts for a
// schema-validating example).
export { readYamlFile, readYamlFileOrThrow } from './lib/yaml.js';
export type { ReadYamlFileOrThrowOptions } from './lib/yaml.js';

// Lib — IDs
export { generateId, generatePrefixedId, extractTimestamp, generateUUID } from './lib/ids.js';

// Lib — retry
export { withRetry } from './lib/retry.js';
export type { RetryOptions } from './lib/retry.js';

// Lib — execution substrate (north-star §5.8, release 2.13.0). One bounded
// scheduler + per-unit timeout/retry that fit + sim recipes run on, so
// timeout/maxParallel/stopOnFirstFailure mean the same thing in every domain
// (and a declared `timeout` actually aborts — the §4.3 sim fix). Plus the shared
// `deriveRecipeId` (one `<prefix>_<name>` scheme across domains).
export {
  scheduleUnits,
  yieldToEventLoop,
  runWithTimeout,
  runWithRetry,
  executePipeline,
} from './lib/execution/index.js';
export type {
  ScheduleUnitsOptions,
  UnitRunOutcome,
  RunWithTimeoutOptions,
  PipelineRetryOptions,
  PipelineRetryOutcome,
  ExecutePipelineOptions,
  WorkflowExecutionOptions,
  WorkflowRetryOptions,
} from './lib/execution/index.js';
export { deriveRecipeId } from './lib/recipe-id.js';

// Lib — package-version reader (used by first-party Tools to set
// metadata.version without duplicating the literal in source).
export { readPackageVersion } from './lib/package-version.js';

// Lib — shared presentation formatters (duration, …) used by more than one
// tool's CLI/report layer; centralized here since tools cannot depend on
// each other.
export { formatDuration } from './lib/format.js';

// Lib — path resolver (project-local opensip-cli/.runtime, user-level
// ~/.opensip-cli/config.yml). Every consumer constructs paths through
// this module so a layout change is a single-file edit.
export { resolveProjectPaths, resolveUserPaths } from './lib/paths.js';
export type { ProjectPaths, UserPaths, PathDomain } from './lib/paths.js';

// Lib — project-context resolver. One-shot ancestor walk from cwd to
// the nearest opensip-cli.config.yml. Returns a ProjectContext that
// every downstream consumer (CLI bootstrap, tool action handlers,
// uninstall/init/dashboard) reads from instead of re-deriving cwd
// semantics.
export { resolveProjectContext } from './lib/project-context.js';
export type { ProjectContext, ResolveProjectContextInput } from './lib/project-context.js';

// Lib — per-invocation presentation settings (banner size + CLI version)
// read by the render paths off `currentScope()?.ui`. Populated by the CLI
// bootstrap; absent in tests and non-rendering callers.
export type { UiContext } from './lib/ui-context.js';

// Lib — config schemaVersion. Permissive top-level field reader +
// CLI/config compatibility classifier. Used by pre-action-hook for
// upgrade-mismatch detection.
export {
  CLI_SUPPORTED_SCHEMA_VERSION,
  readConfigSchemaVersion,
  checkSchemaCompat,
} from './lib/config-version.js';
export type { SchemaCompat } from './lib/config-version.js';

// Lib — phantom-dir detector. Warns about orphaned opensip-cli/
// subtrees left over from pre-discovery runs. Returns paths; callers
// surface them; never auto-deletes.
export { detectPhantomRuntimes } from './lib/phantom-detect.js';
