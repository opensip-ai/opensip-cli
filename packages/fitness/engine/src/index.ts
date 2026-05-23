// Framework — check definition API
export { defineCheck } from './framework/define-check.js';
export { defineRegexListCheck } from './framework/define-regex-list-check.js';
export type {
  RegexListCheckPattern,
  RegexListCheckOptions,
  DefineRegexListCheckConfig,
} from './framework/define-regex-list-check.js';
export { CheckRegistry, defaultRegistry } from './framework/registry.js';
export { registerChecks } from './framework/register-helpers.js';

// Re-exported kernel helpers — convenience for check packs that depend
// only on @opensip-tools/fitness. `readPackageVersion` lets a pack's
// barrel set `metadata.version` from its own package.json instead of
// duplicating the literal.
export { readPackageVersion } from '@opensip-tools/core';

// Framework types — the real check API types
export type { CheckViolation, CheckScope, FileAccessor, CheckConcern, CheckLanguage } from './framework/check-config.js';
export type { Check, CheckConfig, ResolvedScope } from './framework/check-types.js';
export { isCheck, collectCheckObjects } from './framework/check-types.js';
export type { ExecutionContext, RunOptions } from './framework/execution-context.js';

// Framework utilities used by checks
export { getLineNumber, extractSnippet, isAPIFile } from './framework/result-builder.js';
// Most TS compiler-API helpers (parseSource, walkNodes,
// getIdentifierName, getPropertyChain, isLiteral, isInStringLiteral)
// live in @opensip-tools/lang-typescript. Only the narrow set fitness
// still owns is re-exported from here.
export {
  getLineNumber as getASTLineNumber,
  isPropertyAccess,
} from './framework/ast-utilities.js';
export { execAbortable } from './framework/abortable-exec.js';
// File cache (used by checks for content access; tests may seed/clear).
export { fileCache, DEFAULT_PREWARM_PATTERNS } from './framework/file-cache.js';
export { buildImportGraph, findStronglyConnectedComponents } from './framework/import-graph.js';
export type { ImportGraph } from './framework/import-graph.js';
export { isInsideStringLiteral, stripStringLiterals, stripStringsAndComments, stripStringsAndCommentsPreservingPositions } from './framework/strip-literals.js';
export { filterContent, clearFilterCache } from './framework/content-filter.js';
export type { FilteredContent } from './framework/content-filter.js';
// Re-export TypeScript compiler API for AST-based checks. The typescript module
// uses `export =`, so `export * as ts from 'typescript'` is invalid; the
// import-then-rename-export form works under esModuleInterop.
/* eslint-disable unicorn/prefer-export-from -- `export * as ts from 'typescript'` is invalid (the module uses `export =`); the namespace import + named export is the only working shape */
import * as _ts from 'typescript';
export { _ts as ts };
/* eslint-enable unicorn/prefer-export-from */


// Types — findings output
export type { Finding, Severity, FindingSeverity, ToolOutput, CheckResult, CheckInfo, CheckResultMetadata, ItemType } from './types/findings.js';
export { createResultWithSignals, createErrorResult, createPassingResult, CheckInfoFactory } from './types/findings.js';

// Recipe service
export { FitnessRecipeService } from './recipes/service.js';
export type { FitnessRecipeServiceConfig, FitnessRecipeServiceCallbacks, CheckSummary } from './recipes/service-types.js';
export type { FitnessRecipe, FitnessRecipeDefinition, FitnessRecipeResult, RecipeCheckResult, RecipeCheckConfigMap } from './recipes/types.js';
export { defineRecipe } from './recipes/types.js';
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

// Check-package discovery (fitness-specific — scans @opensip-tools/checks-* packages).
export {
  discoverCheckPackages,
  readCheckPackageMetadata,
  readCheckPackagePreferences,
} from './plugins/check-package-discovery.js';
export type {
  CheckPackageDiscoveryOptions,
  DiscoveredCheckPackage,
  CheckPackageMetadata,
} from './plugins/check-package-discovery.js';

// Tool plugin export — fitness as a Tool.
export { fitnessTool } from './tool.js';

// CLI command implementations — re-exported for the Phase 2 CLI which
// still drives commands directly. Phase 4 will collapse these behind
// the Tool contract.
export {
  executeFit,
  ensureChecksLoaded,
  getDisplayName,
  getEnabledCheckCount,
  getIcon,
  getPluginLoadErrors,
  setPreLoadHook,
  formatDuration,
  formatValidatedColumn,
} from './cli/fit.js';
export type { PreLoadHook } from './cli/fit.js';
export { openDashboard } from './cli/dashboard.js';
export { listChecks } from './cli/list-checks.js';
export { listRecipes } from './cli/list-recipes.js';

// Architecture-gate primitives (baseline save / compare) and SARIF
// upload — both operate on fitness's CliOutput. Wired into the `fit`
// subcommand by the tool's register() handler.
export {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GateBaselineMissingError,
  GateBaselineInvalidError,
  DEFAULT_BASELINE_PATH,
} from './gate.js';
export type { GateCompareResult } from './gate.js';
export { buildSarifLog, chunkSarifRuns, reportToCloud } from './sarif.js';
export type { ReportResult } from './sarif.js';

// Shared utilities for check authors (extracted from per-pack copies).
export { isCommentLine, isTestFile, getCheckDisplayName, getCheckIcon } from './check-utils/index.js';
export type { IsCommentLineOptions, IsTestFileOptions } from './check-utils/index.js';
