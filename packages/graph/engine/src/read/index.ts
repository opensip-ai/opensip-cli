/**
 * @opensip-cli/graph/read — stable public read/rebuild facade (ADR-0147).
 *
 * Free functions returning Result / canonical DTOs. Repositories, rules, and
 * orchestration remain private. MCP and other consumers import this subpath only.
 */

export { readCatalogIdentity, loadCatalogGeneration } from './catalog.js';
export {
  buildGraphReadIndexes,
  deriveGraphReadFeatures,
  evaluateGraphOrphans,
  classifyGraphReadCatalog,
  computeGraphReadFilesFingerprint,
} from './analysis.js';
export { rebuildCatalog } from './rebuild.js';
export { matchesGraphSourceFilter, matchesFilePrefix } from './source-filter.js';
export {
  toGraphSymbolRef,
  GRAPH_SYMBOL_PATH_MAX,
  GRAPH_SYMBOL_NAME_MAX,
  GRAPH_SYMBOL_PACKAGE_MAX,
} from './query-contracts.js';
export { verifyCatalogInputs, isSafeAdapterDescriptor } from './catalog-freshness.js';

export type {
  GraphReadError,
  GraphReadOperation,
  CatalogIdentity,
  RebuildCatalogInput,
  CatalogVerdict,
  ValidationContext,
  Catalog,
  Indexes,
  FeatureColumn,
  GraphConfig,
} from './types.js';

export type {
  SourceScope,
  GeneratedPolicy,
  TraversalIdentity,
  PackageEdgeKind,
  GraphSourceFilter,
  EffectiveGraphSourceFilter,
  GraphReadCoverage,
  GraphSymbolRef,
  CallEdgeEvidence,
  FreshnessReasonCode,
  FreshnessChangeSummary,
  FreshnessVerification,
  AdapterSelectionEvidence,
  CatalogEngineMode,
} from './query-contracts.js';

export type {
  GraphAdapterRegistryReader,
  VerifyCatalogInputsInput,
} from './catalog-freshness.js';
