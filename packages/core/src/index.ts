// Framework — check definition API
export { defineCheck } from './framework/define-check.js';
export { CheckRegistry, defaultRegistry } from './framework/registry.js';
export { registerChecks } from './framework/register-helpers.js';

// Framework types — the real check API types
export type { CheckViolation, CheckScope, FileAccessor, CheckConcern, CheckLanguage } from './framework/check-config.js';
export type { Check, CheckConfig, ResolvedScope } from './framework/check-types.js';
export { isCheck } from './framework/check-types.js';
export type { ExecutionContext, RunOptions } from './framework/execution-context.js';

// Framework utilities used by checks
export { getLineNumber, extractSnippet, isAPIFile } from './framework/result-builder.js';
export {
  parseSource, walkNodes,
  getLineNumber as getASTLineNumber,
  getIdentifierName, getPropertyChain,
  isInStringLiteral,
  isLiteral, isPropertyAccess,
} from './framework/ast-utilities.js';
export { execAbortable } from './framework/abortable-exec.js';
export { isInsideStringLiteral } from './framework/strip-literals.js';
export { filterContent, clearFilterCache } from './framework/content-filter.js';
export type { FilteredContent } from './framework/content-filter.js';
// Re-export TypeScript compiler API for AST-based checks
import * as _ts from 'typescript';
export { _ts as ts };

// Types — findings output
export type { Finding, Severity, FindingSeverity, ToolOutput, CheckResult, CheckInfo, CheckResultMetadata, ItemType } from './types/findings.js';
export { createResultWithSignals, createErrorResult, createPassingResult, CheckInfoFactory } from './types/findings.js';

// Types — internal signal (framework use)
export type { Signal, SignalSeverity, SignalCategory, CreateSignalInput, FixHint } from './types/signal.js';
export { createSignal } from './types/signal.js';

// Recipe service
export { FitnessRecipeService } from './recipes/service.js';
export type { FitnessRecipeServiceConfig, FitnessRecipeServiceCallbacks, CheckSummary } from './recipes/service-types.js';
export type { FitnessRecipeResult, RecipeCheckResult, RecipeCheckConfigMap } from './recipes/types.js';
export { builtInRecipesByName } from './recipes/built-in-recipes.js';
export { defaultRecipeRegistry, FitnessRecipeRegistry } from './recipes/registry.js';
export { getCheckConfig } from './recipes/check-config.js';

// Targets and signalers
export { loadTargetsConfig, resolveTargetFiles } from './targets/index.js';
export type { TargetsConfig } from './targets/types.js';
export { TargetRegistry } from './targets/target-registry.js';
export { buildScopeBasedFileMap } from './framework/scope-resolver.js';
export { loadSignalersConfig } from './signalers/index.js';
export type { SignalersConfig } from './signalers/types.js';

export { PROJECT_CONFIG_FILENAME, resolveProjectConfigPath } from './config-resolution.js';

// Plugins
export {
  discoverPlugins,
  loadAllPlugins,
  getPluginDir,
  getBaseDir,
  getProjectPluginDir,
  resolvePluginDir,
  hasProjectPluginsDeclared,
  readProjectPluginsList,
} from './plugins/index.js';
export type { PluginDomain, DiscoveredPlugin, LoadedPlugin, PluginLoadResult } from './plugins/types.js';

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
