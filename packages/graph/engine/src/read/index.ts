/**
 * @opensip-cli/graph/read — stable public read/rebuild facade (ADR-0147).
 *
 * Free functions returning Result / canonical DTOs. Repositories, rules, and
 * orchestration remain private. MCP and other consumers import this subpath only.
 */

export { readCatalogIdentity, loadCatalogGeneration } from './catalog.js';
export { loadGraphReadConfig } from './config.js';
export {
  buildGraphReadIndexes,
  deriveGraphReadFeatures,
  evaluateGraphOrphans,
  classifyGraphReadCatalog,
  computeGraphReadFilesFingerprint,
} from './analysis.js';
export { rebuildCatalog } from './rebuild.js';
export {
  compareCodePointStrings,
  codePointSortKey,
  continuationToken,
} from '../code-point-order.js';
export {
  matchesGraphSourceFilter,
  matchesGraphSourceFilterWithRoles,
  matchesFilePrefix,
  compileSourceRoleMatcher,
  effectiveTestSource,
  MAX_AUDIT_SOURCE_ROLE_FILES,
} from './source-filter.js';
export type { SourceRoleMatcher, SourceRoleLimits } from './source-filter.js';
export {
  toGraphSymbolRef,
  graphPackageOf,
  toGraphPackageName,
  GRAPH_SYMBOL_PATH_MAX,
  GRAPH_SYMBOL_NAME_MAX,
  GRAPH_SYMBOL_PACKAGE_MAX,
} from './query-contracts.js';
export { verifyCatalogInputs, isSafeAdapterDescriptor } from './catalog-freshness.js';
export { buildOccurrenceCallView } from './occurrence-call-view.js';
export {
  buildPackageEvidence,
  packageDependencyStableKey,
  packageCallEvidenceStableKey,
  packageImportEvidenceStableKey,
} from './package-evidence.js';
export { buildPackageScc } from './package-scc.js';
export {
  searchSymbolOccurrences,
  symbolSearchStableKey,
  compareSymbolRefs,
} from './symbol-search.js';
export {
  buildArchitectureView,
  packageEdgeStableKey,
  hotspotStableKey,
} from './architecture-view.js';

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
  FeatureTable,
  GraphConfig,
  GraphAdapterRegistryReader,
} from './types.js';

export type {
  SourceScope,
  GeneratedPolicy,
  TraversalIdentity,
  PackageEdgeKind,
  GraphSourceFilter,
  EffectiveGraphSourceFilter,
  AuditSourceRolePolicy,
  GraphReadCoverage,
  GraphSymbolRef,
  CallEdgeEvidence,
  PackageCallEvidence,
  PackageImportEvidence,
  PackageDependencyEvidence,
  FreshnessReasonCode,
  FreshnessChangeSummary,
  FreshnessVerification,
  AdapterSelectionEvidence,
  CatalogEngineMode,
} from './query-contracts.js';

export type { VerifyCatalogInputsInput } from './catalog-freshness.js';

export type { OccurrenceCallViewQuery, OccurrenceCallView } from './occurrence-call-view.js';

export type {
  PackageEvidenceQuery,
  PackageCallEvidenceRow,
  PackageImportEvidenceRow,
  PackageEvidenceView,
} from './package-evidence.js';
export type {
  PackageCycleComponent,
  PackageCycleProofEdge,
  PackageSccView,
} from './package-scc.js';

export type { SymbolSearchMatch, SymbolSearchQuery, SymbolSearchView } from './symbol-search.js';

export type {
  ArchitectureViewQuery,
  LabelledNodeCount,
  LabelledPackageCount,
  LabelledDistribution,
  CallEvidenceMetrics,
  ArchitecturePackageEdgeRow,
  ArchitectureHotspot,
  ArchitectureView,
} from './architecture-view.js';
