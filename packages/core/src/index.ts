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
  getPluginDir,
  getBaseDir,
  getProjectPluginDir,
  resolvePluginDir,
  hasProjectPluginsDeclared,
  readProjectPluginsList,
  discoverCheckPackages,
  readCheckPackageMetadata,
  readCheckPackagePreferences,
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
  CheckPackageDiscoveryOptions,
  DiscoveredCheckPackage,
  CheckPackageMetadata,
} from './plugins/index.js';

// Lib — errors + Result pattern
export { ToolError, ValidationError, NotFoundError, SystemError, TimeoutError, NetworkError, ConfigurationError } from './lib/errors.js';
export { ok, err, tryCatchAsync, tryCatch } from './lib/errors.js';
export type { Result, ToolErrorOptions } from './lib/errors.js';

// Lib — logger
export { logger, setLogLevel, setSilent, setDebugMode, setRunId, getRunId, initLogFile } from './lib/logger.js';

// Lib — IDs
export { generateId, generatePrefixedId, extractTimestamp, generateUUID } from './lib/ids.js';

// Lib — retry
export { withRetry } from './lib/retry.js';
export type { RetryOptions } from './lib/retry.js';
