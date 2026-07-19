/**
 * @opensip-cli/graph/read — stable public read/rebuild facade (ADR-0147).
 *
 * Free functions returning Result / canonical DTOs. Repositories, rules, and
 * orchestration remain private. MCP and other consumers import this subpath only.
 */

export { buildComputeImpactIndex } from '@opensip-cli/contracts';
export type {
  ComputeImpactAsyncOptions,
  ComputeImpactIndex,
  ComputeImpactOptions,
} from '@opensip-cli/contracts';

export { readCatalogIdentity, loadCatalogGeneration } from './catalog.js';
export { catalogGenerationKey } from './catalog-generation-key.js';
export { readContextSnapshot } from './context-snapshot.js';
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
export {
  clampLimit,
  isCapReason,
  makeFacet,
  mergeFacet,
  rollupFacets,
  UNREQUESTED_FACET,
} from './bounded-view.js';
export type { CoverageFacetSet } from './bounded-view.js';
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
  matchesSymbolSearchQuery,
} from './symbol-search.js';
export {
  buildArchitectureView,
  packageEdgeStableKey,
  hotspotStableKey,
} from './architecture-view.js';
export { buildImpactView, MAX_IMPACT_VIEW_FILES, MAX_IMPACT_VIEW_ROWS } from './impact-view.js';
export { projectEntityDetail } from './entity-detail-view.js';
export {
  selectStaticTests,
  MAX_TEST_SELECTION_FILES,
  MAX_TEST_SELECTION_DEPTH,
  MAX_TEST_SELECTION_CANDIDATES,
  MAX_TEST_SELECTION_COMMANDS,
  MAX_TEST_SELECTION_PROOF_NODES,
  MAX_TEST_SELECTION_VISITED_NODES,
  MAX_TEST_SELECTION_VISITED_EDGES,
} from './test-selection-view.js';

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
  CoverageFacet,
  CoverageFacetName,
  GraphReadFacetCoverage,
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
export type {
  ContextSnapshotAccessor,
  ContextSnapshotKind,
  ContextSnapshotLookup,
  ContextSnapshotPayload,
  ContextSnapshotRecord,
  ContextSnapshotSaveInput,
  ContextSnapshotSaveResult,
} from './context-snapshot.js';

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

export {
  searchDeclarationFacts,
  referencesToDeclaration,
  declarationStableKey,
  referenceStableKey,
  compareDeclarationRefs,
  compareReferenceSites,
} from './declaration-reference-view.js';
export type {
  DeclarationSearchMatch,
  DeclarationSearchQuery,
  DeclarationRef,
  DeclarationSearchView,
  ReferencesToQuery,
  ReferenceSiteRef,
  ReferencesToView,
} from './declaration-reference-view.js';

export type {
  ArchitectureViewQuery,
  ArchitectureSection,
  ArchitectureFamilySummary,
  LabelledNodeCount,
  LabelledPackageCount,
  LabelledDistribution,
  CallEvidenceMetrics,
  ArchitecturePackageEdgeRow,
  ArchitectureHotspot,
  ArchitectureView,
} from './architecture-view.js';
export type { GraphImpactView, ImpactViewOptions } from './impact-view.js';
export type { GraphEntityDetail, GraphEntityParameter } from './entity-detail-view.js';
export type { StaticTestSelectionOptions, StaticTestSelectionView } from './test-selection-view.js';
