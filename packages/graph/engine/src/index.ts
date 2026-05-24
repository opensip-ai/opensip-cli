/**
 * @opensip-tools/graph — public barrel.
 *
 * The graph tool implements a strict six-stage pipeline:
 * discover → inventory → edges → indexes → rules → render.
 * Per spec docs/plans/graph-tool-v2-design.md.
 */

export { graphTool } from './tool.js';
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
export { MemoryPressureError } from './cli/pressure-monitor.js';
export {
  HEAP_TARGETS,
  decideHeapTargetMb,
  systemHasMemoryFor,
} from './cli/heap-preflight.js';
export type {
  Catalog,
  FunctionOccurrence,
  CallEdge,
  Param,
  Indexes,
  Rule,
  RuleHints,
  GraphConfig,
  ResolutionStats,
  ResolverVerdict,
  ParseError,
  FunctionKind,
  CallResolution,
  CallConfidence,
  Visibility,
} from './types.js';
export type { Renderer, RenderContext } from './render/types.js';
export type { EdgeResolver, ResolverContext } from './lang-typescript/edge-resolvers/types.js';
export type { InventoryVisitor, VisitorContext } from './lang-typescript/inventory-visitors/types.js';

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
  CacheKeyInput,
  ParsedProject,
} from './lang-adapter/types.js';
export type { CallConfidence as AdapterCallConfidence } from './types.js';
export { registerAdapter, pickAdapter } from './lang-adapter/registry.js';
export {
  truncateForCallEdge,
  CALL_EDGE_TEXT_MAX,
  CREATION_EDGE_PREFIX,
  CREATION_EDGE_TEXT_MAX,
  appendEdge,
  createMutableStats,
  pushCreationEdge,
} from './lang-adapter/edge-helpers.js';
export type { EdgePosition } from './lang-adapter/edge-helpers.js';

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
