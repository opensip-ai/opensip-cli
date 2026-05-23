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
} from './plugins/index.js';
export type {
  PluginDomain,
  DiscoveredPlugin,
  LoadedPlugin,
  PluginLoadResult,
  LangPluginExports,
  PluginExports,
  PluginMetadata,
  CheckDisplayEntry,
  PackageEntryResolution,
  ToolPackageDiscoveryOptions,
  DiscoveredToolPackage,
  ToolPackageMetadata,
} from './plugins/index.js';

// Tools — kernel-level Tool plugin contract.
// (discoverToolPackages and friends live under plugins/ and are
// re-exported above; the Tool / Registry types are tool-shape, not
// plugin-discovery-shape, hence the separate barrel.)
export { ToolRegistry, defaultToolRegistry, UnknownLiveViewError } from './tools/index.js';
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

// Lib — errors + Result pattern
export { ToolError, ValidationError, NotFoundError, SystemError, TimeoutError, NetworkError, ConfigurationError } from './lib/errors.js';
export { ok, err, tryCatchAsync, tryCatch } from './lib/errors.js';
export type { Result, ToolErrorOptions } from './lib/errors.js';

// Lib — logger
export { logger, setLogLevel, setSilent, setDebugMode, setRunId, getRunId, initLogFile } from './lib/logger.js';
export type { Logger } from './lib/logger.js';

// Lib — permissive YAML reader (returns undefined on missing/malformed
// files). Used by plugin-discovery sites that need to peek at a single
// field of opensip-tools.config.yml without dragging in a Zod schema.
// Tools that need structured parse errors should keep their dedicated
// loader (see fitness's targets/loader.ts).
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
