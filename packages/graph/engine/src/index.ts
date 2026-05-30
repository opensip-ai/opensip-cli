// @fitness-ignore-file module-coupling-fan-out -- Public barrel: re-exports the surface of each pipeline stage; fan-out is the contract of this file
/**
 * @opensip-tools/graph — public barrel.
 *
 * The graph tool implements a strict six-stage pipeline:
 * discover → inventory → edges → indexes → rules → render.
 */

// Side-effect import: surfaces the `scope.graph` augmentation on
// @opensip-tools/core's RunScope interface (D7 — tool subscopes via
// module augmentation).
import './scope-augmentation.js';
export type { GraphSubscope } from './scope-augmentation.js';

// Re-exported as `tool` so the third-party plugin-discovery walker
// (which keys on `mod.tool`) treats first-party and third-party Tool
// packages uniformly; dedup at register-tools.ts handles the
// duplicate-id case.
export { graphTool, graphTool as tool } from './tool.js';
export { runGraph, GRAPH_STAGES } from './cli/orchestrate.js';
export type {
  GraphStage,
  GraphProgressEvent,
  GraphProgressCallback,
  RunGraphInput,
  RunGraphResult,
} from './cli/orchestrate.js';
export { buildUnifiedReportLines } from './cli/graph.js';
export type { UnifiedReportInput } from './cli/graph.js';
// Graph catalog persistence — exposed so consumers (e.g. fitness's
// dashboard command) can read the catalog via a typed repo instead of
// raw SQL against the graph_catalog table (audit 2026-05-29, H1).
export { CatalogRepo } from './persistence/catalog-repo.js';
export { MemoryPressureError } from './cli/pressure-monitor.js';
export {
  HEAP_TARGETS,
  decideHeapTargetMb,
  systemHasMemoryFor,
  runHeapPreflight,
  totalSystemMemoryMb,
} from './cli/heap-preflight.js';
export type {
  Catalog,
  FunctionOccurrence,
  CallEdge,
  DependencyEdge,
  Param,
  Indexes,
  BlastScore,
  Rule,
  RuleHints,
  GraphConfig,
  ResolutionStats,
  ResolverVerdict,
  ParseError,
  FunctionKind,
  CallResolution,
  CallConfidence,
  ResolutionMode,
  CrossBoundaryCall,
  Visibility,
} from './types.js';
export type { Renderer, RenderContext } from './render/types.js';
export type { Shard, ShardBuildResult } from './cli/orchestrate/shard-model.js';

// EdgeResolver, ResolverContext, InventoryVisitor, VisitorContext used
// to live here as TS-specific re-exports. PR 1b moved them to
// @opensip-tools/graph-typescript along with the rest of the lang-
// typescript subtree. Adapter-pack tests that need these types now
// import them from the adapter-pack barrel directly.

// ── GraphLanguageAdapter contract surface ─────────────────────────
//
// Promoted to the public barrel by PR 1a of plan
// docs/plans/architecture/2026-05-23-plan-graph-adapter-package-split.md.
// External adapter packs (e.g. @opensip-tools/graph-typescript) import
// these types to satisfy the contract defined in lang-adapter/types.ts.
//
// The set is locked at the eight contract types + four edge-helper
// symbols from the per-symbol justification table in that plan. Adding
// a new symbol incurs a major-version revision; promote with care.
//
// MutableStats is intentionally NOT promoted — adapters receive the
// instance via ResolveInput.stats and call its methods; the constructor
// stays internal. (`createMutableStats` IS exposed because the test
// suites of the relocated adapter packs use it; the engine itself
// hands a stats instance into resolveCallSites at runtime.)
export type {
  GraphLanguageAdapter,
  DiscoverInput,
  DiscoverOutput,
  ParseInput,
  ParseOutput,
  WalkInput,
  WalkOutput,
  ResolveInput,
  ResolveOutput,
  CallSiteRecord,
  DependencySiteRecord,
  CacheKeyInput,
  ParsedProject,
} from './lang-adapter/types.js';
export type { CallConfidence as AdapterCallConfidence } from './types.js';
export {
  pickAdapter,
  createAdapterRegistry,
  currentAdapterRegistry,
  setDiscoveredAdapters,
  getDiscoveredAdapters,
  GraphAdapterRegistry,
} from './lang-adapter/registry.js';
export {
  truncateForCallEdge,
  CALL_EDGE_TEXT_MAX,
  CREATION_EDGE_PREFIX,
  CREATION_EDGE_TEXT_MAX,
  appendEdge,
  createMutableStats,
  pushCreationEdge,
} from './lang-adapter/edge-helpers.js';
// MutableStats is the return TYPE of createMutableStats. Adapter packs
// receive instances and pass them down the resolver call chain — the
// type annotation is required at internal helper boundaries. The
// constructor (`createMutableStats`) is the public construction
// surface; the interface name is just necessary to spell parameter
// types. Exporting the type alone preserves the plan's intent (no
// alternate construction path) without forcing adapter packs to
// inline the structural type at every helper boundary.
export type { EdgePosition, MutableStats } from './lang-adapter/edge-helpers.js';

// ── Graph adapter discovery (used by the CLI to load adapter packs) ─
export {
  discoverGraphAdapterPackages,
  readGraphAdapterPackageMetadata,
  readGraphAdapterPackagePreferences,
} from './plugins/graph-adapter-discovery.js';
export type {
  DiscoveredGraphAdapterPackage,
  GraphAdapterDiscoveryOptions,
  GraphAdapterPackageMetadata,
} from './plugins/graph-adapter-discovery.js';

// PR 3 of plan 2026-05-23-plan-graph-adapter-package-split.md: with
// all three first-party adapters relocated into their own packages
// (graph-typescript, graph-python, graph-rust), the engine no longer
// re-exports any adapter, parsed-project type, or rule-hints
// constant. Cross-package tests import directly from each adapter
// pack.

// Pipeline + rule helpers required by cross-package integration tests.
// These belong to the engine; the public-barrel exposure is to support
// the graph-typescript test suite without forcing it to deep-import
// engine internals.
export { buildIndexes } from './pipeline/indexes.js';
export { alwaysThrowsBranchRule } from './rules/always-throws-branch.js';
export { noSideEffectPathRule } from './rules/no-side-effect-path.js';
export { duplicatedFunctionBodyRule } from './rules/duplicated-function-body.js';
export { orphanSubtreeRule } from './rules/orphan-subtree.js';
export { executeGraph } from './cli/graph.js';
