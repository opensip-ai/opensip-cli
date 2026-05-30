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
// TS compiler-API helpers (parseSource, walkNodes, getIdentifierName,
// getPropertyChain, isLiteral, isInStringLiteral, isPropertyAccess, and
// node→line lookup) live in @opensip-tools/lang-typescript. Check packs
// import them directly from the language adapter; fitness no longer
// re-exports any of them.
export { execAbortable } from './framework/abortable-exec.js';
// File cache (used by checks for content access; tests may seed/clear).
export { fileCache, DEFAULT_PREWARM_PATTERNS } from './framework/file-cache.js';
export { buildImportGraph, findStronglyConnectedComponents } from './framework/import-graph.js';
export type { ImportGraph } from './framework/import-graph.js';
export { isInsideStringLiteral, stripStringLiterals, stripStringsAndComments, stripStringsAndCommentsPreservingPositions } from './framework/strip-literals.js';
// The two-stripper split (this module's regex-based strippers vs.
// `filterContent` in `@opensip-tools/lang-typescript`) is documented at
// the top of `framework/strip-literals.ts`. Short version: regex
// strippers are language-agnostic and good enough for universal/text
// checks; `filterContent` is TS-aware, position-preserving, and used by
// TS-specific checks. The dispatch boundary that picks one is
// `applyContentFilter` in
// `@opensip-tools/core/languages/content-filter-dispatch.ts`.
// Importers wanting the TS-AST stripper depend on
// `@opensip-tools/lang-typescript` directly.


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

// Tool plugin export — fitness as a Tool. Re-exported as `tool` so the
// third-party plugin-discovery walker (which keys on `mod.tool`) treats
// first-party and third-party Tool packages uniformly; dedup at
// register-tools.ts handles the duplicate-id case.
export { fitnessTool, fitnessTool as tool } from './tool.js';

// CLI command implementations — re-exported for the Phase 2 CLI which
// still drives commands directly. Phase 4 will collapse these behind
// the Tool contract.
//
// Audit 2026-05-29 (L2): `executeFit` retains a live consumer — the
// SaaS-mode concurrency test (cli/__tests__/saas-mode-smoke.test.ts). It
// is active API, not dead code; removing it needs that consumer migrated
// to the Tool contract first (Phase 4), which is out of scope for L2.
//
// The old `openDashboard` export is GONE (L2): fitness no longer owns
// dashboard composition. It now contributes only its own dashboard
// inputs via `collectFitnessDashboardData`, wired into `fitnessTool`'s
// `collectDashboardData`. The CLI is the composition root.
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
// Fitness's dashboard-data collector — exported for unit coverage and
// so the Tool descriptor can reference it. The CLI walks every tool's
// `collectDashboardData`; it does not import this symbol directly.
export { collectFitnessDashboardData } from './cli/dashboard.js';
export type { CheckCatalogEntry, RecipeCatalogEntry } from './cli/dashboard.js';
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
} from './gate.js';
export type { GateCompareResult } from './gate.js';
export { FitBaselineRepo } from './persistence/baseline-repo.js';
// SARIF + cloud reporting moved to @opensip-tools/contracts (audit
// 2026-05-29, M1) so graph can report without a graph→fitness cycle.
// Import buildSarifLog / chunkSarifRuns / reportToCloud / ReportResult
// from @opensip-tools/contracts.

// Shared utilities for check authors (extracted from per-pack copies).
export { isCommentLine, isTestFile, getCheckDisplayName, getCheckIcon } from './check-utils/index.js';
export type { IsCommentLineOptions, IsTestFileOptions } from './check-utils/index.js';
