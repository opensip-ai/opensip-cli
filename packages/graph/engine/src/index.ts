/**
 * @opensip-tools/graph — code-path graph + dead-end detector for OpenSIP Tools.
 *
 * Public surface:
 *   - `graphTool` — the Tool plugin export. Registered by the CLI.
 *   - Catalog primitives (types, builder, cache) — exposed for tests and
 *     for the future `@opensip-tools/checks-graph` shim (spec §10).
 *   - Rule registry — for the dashboard panel and the SDK consumers
 *     who want to run rules against an externally-built catalog.
 *   - Gate primitives — mirrors the fitness export shape.
 */

// Tool plugin export
export { graphTool } from './tool.js';

// Catalog primitives
export type {
  Catalog,
  CatalogIndex,
  CatalogV1,
  CallConfidence,
  CallResolution,
  CallSite,
  FileImport,
  FileNode,
  FunctionKind,
  FunctionNode,
  FunctionParam,
  FunctionVisibility,
  SideEffectKind,
} from './catalog/types.js';
export { CATALOG_LANGUAGE, CATALOG_TOOL, CATALOG_VERSION } from './catalog/types.js';
export { buildCatalog, createProgramFromTsConfig, resolveTsConfigPath } from './catalog/builder.js';
export type { BuilderOptions, BuildResult, ResolverMode } from './catalog/builder.js';
export { hashFunctionBody, hashFileContent, makeFunctionId, parseFunctionId } from './catalog/ids.js';
export { buildIndexes } from './catalog/index-builder.js';
export { readCatalog, writeCatalog, whyCacheInvalid, emptyIndex } from './catalog/cache.js';

// Analysis
export type { GraphFinding } from './analysis/types.js';
export { GRAPH_RULES, evaluateAllRules } from './analysis/rules-registry.js';
export type { GraphRule, RulePhase } from './analysis/rules-registry.js';

// CLI surfaces — exported for callers that want to drive the run path
// without spinning up Commander (tests, programmatic SDK consumers).
export { executeGraph } from './cli/graph.js';
export type { ExecuteGraphArgs, ExecuteGraphResult } from './cli/graph.js';
export { executeEntryPoints } from './cli/entry-points.js';
export type { ExecuteEntryPointsArgs, ExecuteEntryPointsResult, EntryPointEntry } from './cli/entry-points.js';
export { executeOrphans } from './cli/orphans.js';
export type { ExecuteOrphansArgs, ExecuteOrphansResult, OrphanEntry } from './cli/orphans.js';
export { runGraph } from './cli/run.js';
export type { RunOptions, RunResult } from './cli/run.js';

// Gate primitives
export {
  saveBaseline,
  compareToBaseline,
  renderGateCompareOutput,
  GraphBaselineMissingError,
  GraphBaselineInvalidError,
  DEFAULT_GRAPH_BASELINE_PATH,
} from './gate.js';
export type { GraphGateCompareResult } from './gate.js';
