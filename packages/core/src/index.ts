// Types — internal signal (shared across tools)
export type { Signal, SignalSeverity, SignalCategory, CreateSignalInput, FixHint } from './types/signal.js';
export { createSignal } from './types/signal.js';

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
  readToolPackageMetadata,
  discoverPackagesByMarker,
  isMarkerKind,
  registerRecipesFromMod,
  loadPlugin,
  loadAllPlugins,
  resolveScopes,
  VALID_NPM_SCOPE_REGEX,
} from './plugins/index.js';
export type {
  PluginDomain,
  DiscoveredPlugin,
  LoadedPlugin,
  PluginLoadResult,
  LangPluginExports,
  PluginExports,
  CheckDisplayEntry,
  PackageEntryResolution,
  ToolPackageDiscoveryOptions,
  DiscoveredToolPackage,
  ToolPackageMetadata,
  MarkerKind,
  MarkerDiscoveryOptions,
  DiscoveredMarkerPackage,
  RegisterRecipesOptions,
  RegisterRecipesResult,
  RegisterCtx,
  RegisterCounts,
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

// Recipes — generic recipe registry shared by fitness + simulation.
export { RecipeRegistry } from './recipes/registry.js';
export type {
  RecipeBase,
  RecipeRegisterOptions,
  RecipeRegistryOptions,
} from './recipes/registry.js';

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
export type {
  RunScopeOptions,
  RecipeCheckConfigSlot,
  DataStoreThunk,
} from './lib/run-scope.js';

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
export { logger, LoggerImpl, setSilent, setDebugMode, setRunId, getRunId, initLogFile } from './lib/logger.js';
export type { Logger, LogLevel, LoggerOptions } from './lib/logger.js';

// Lib — permissive YAML reader (returns undefined on missing/malformed
// files). Used by plugin-discovery sites that need to peek at a single
// field of opensip-tools.config.yml without dragging in a Zod schema.
// Advanced / discouraged for general use — tools that need structured
// parse errors should keep their dedicated loader (see fitness's
// targets/loader.ts).
export { readYamlFile } from './lib/yaml.js';

// Lib — IDs
export { generateId, generatePrefixedId, extractTimestamp, generateUUID } from './lib/ids.js';

// Lib — retry
export { withRetry } from './lib/retry.js';
export type { RetryOptions } from './lib/retry.js';

// Lib — package-version reader (used by first-party Tools to set
// metadata.version without duplicating the literal in source).
export { readPackageVersion } from './lib/package-version.js';

// Lib — path resolver (project-local opensip-tools/.runtime, user-level
// ~/.opensip-tools/config.yml). Every consumer constructs paths through
// this module so a layout change is a single-file edit.
export { resolveProjectPaths, resolveUserPaths } from './lib/paths.js';
export type { ProjectPaths, UserPaths, PathDomain, PluginsPathDomain } from './lib/paths.js';

// Lib — project-context resolver. One-shot ancestor walk from cwd to
// the nearest opensip-tools.config.yml. Returns a ProjectContext that
// every downstream consumer (CLI bootstrap, tool action handlers,
// uninstall/init/dashboard) reads from instead of re-deriving cwd
// semantics.
export { resolveProjectContext } from './lib/project-context.js';
export type { ProjectContext, ResolveProjectContextInput } from './lib/project-context.js';

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
