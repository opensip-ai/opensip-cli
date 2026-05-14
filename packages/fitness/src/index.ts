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
export { buildImportGraph, findStronglyConnectedComponents } from './framework/import-graph.js';
export type { ImportGraph } from './framework/import-graph.js';
export { isInsideStringLiteral, stripStringLiterals, stripStringsAndComments, stripStringsAndCommentsPreservingPositions } from './framework/strip-literals.js';
export { filterContent, clearFilterCache } from './framework/content-filter.js';
export type { FilteredContent } from './framework/content-filter.js';
// Re-export TypeScript compiler API for AST-based checks
import * as _ts from 'typescript';
export { _ts as ts };

// Types — findings output
export type { Finding, Severity, FindingSeverity, ToolOutput, CheckResult, CheckInfo, CheckResultMetadata, ItemType } from './types/findings.js';
export { createResultWithSignals, createErrorResult, createPassingResult, CheckInfoFactory } from './types/findings.js';

// Recipe service
export { FitnessRecipeService } from './recipes/service.js';
export type { FitnessRecipeServiceConfig, FitnessRecipeServiceCallbacks, CheckSummary } from './recipes/service-types.js';
export type { FitnessRecipeResult, RecipeCheckResult, RecipeCheckConfigMap } from './recipes/types.js';
export { builtInRecipesByName } from './recipes/built-in-recipes.js';
export { defaultRecipeRegistry, FitnessRecipeRegistry } from './recipes/registry.js';
export { getCheckConfig, setCurrentRecipeCheckConfig, clearCurrentRecipeCheckConfig } from './recipes/check-config.js';

// Targets and signalers
export { loadTargetsConfig, resolveTargetFiles } from './targets/index.js';
export type { TargetsConfig } from './targets/types.js';
export { TargetRegistry } from './targets/target-registry.js';
export { buildScopeBasedFileMap } from './framework/scope-resolver.js';
export { loadSignalersConfig } from './signalers/index.js';
export type { SignalersConfig } from './signalers/types.js';

// Plugin loader (fitness owns the dispatcher; lang plugins also flow through
// it because lang adapter loading currently shares the same orchestration).
export { loadPlugin, loadAllPlugins } from './plugins/loader.js';
export type { FitPluginExports } from './plugins/types.js';
