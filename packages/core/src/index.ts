// Types — internal signal (shared across tools)
export type { Signal, SignalSeverity, SignalCategory, CreateSignalInput, FixHint } from './types/signal.js';
export { createSignal, isErrorSeverity, isErrorSignal } from './types/signal.js';
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

// Runtime — live-run progress transport seam (ADR-0015). Generic over the event
// type so the kernel never names cli-ui's concrete ProgressEvent.
export { createInProcessTransport } from './runtime/in-process-transport.js';
export type { ProgressTransport, ProgressRun, ProgressJob } from './runtime/progress-transport.js';

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
  discoverPackagesInNodeModules,
  isMarkerKind,
  readMarkerKind,
  MARKER_KINDS,
  discoverScopedPackages,
  hasPackageJson,
  resolvePackageDir,
  registerRecipesFromMod,
  loadPlugin,
  loadAllPlugins,
  resolveScopes,
  VALID_NPM_SCOPE_REGEX,
} from './plugins/index.js';
export type {
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
  DiscoveredScopedPackage,
  DiscoverScopedPackagesOptions,
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
  ToolCliContext,
  ToolPluginExports,
  LiveViewRenderer,
} from './tools/index.js';
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
export { RunScope, runWithScope, runWithScopeSync, enterScope, currentScope } from './lib/run-scope.js';
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
} from './lib/scope-types.js';

// Lib — errors + Result pattern
export { ToolError, ValidationError, NotFoundError, SystemError, TimeoutError, NetworkError, ConfigurationError } from './lib/errors.js';
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

// Lib — permissive YAML reader (returns undefined on missing/malformed
// files). Used by plugin-discovery sites that need to peek at a single
// field of opensip-tools.config.yml without dragging in a Zod schema.
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

// Lib — package-version reader (used by first-party Tools to set
// metadata.version without duplicating the literal in source).
export { readPackageVersion } from './lib/package-version.js';

// Lib — shared presentation formatters (duration, …) used by more than one
// tool's CLI/report layer; centralized here since tools cannot depend on
// each other.
export { formatDuration } from './lib/format.js';

// Lib — path resolver (project-local opensip-tools/.runtime, user-level
// ~/.opensip-tools/config.yml). Every consumer constructs paths through
// this module so a layout change is a single-file edit.
export { resolveProjectPaths, resolveUserPaths } from './lib/paths.js';
export type { ProjectPaths, UserPaths, PathDomain } from './lib/paths.js';

// Lib — project-context resolver. One-shot ancestor walk from cwd to
// the nearest opensip-tools.config.yml. Returns a ProjectContext that
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

// Lib — phantom-dir detector. Warns about orphaned opensip-tools/
// subtrees left over from pre-discovery runs. Returns paths; callers
// surface them; never auto-deletes.
export { detectPhantomRuntimes } from './lib/phantom-detect.js';
