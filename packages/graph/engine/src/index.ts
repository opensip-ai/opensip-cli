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
  runHeapPreflight,
  totalSystemMemoryMb,
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
  CacheKeyInput,
  ParsedProject,
} from './lang-adapter/types.js';
export type { CallConfidence as AdapterCallConfidence } from './types.js';
export { registerAdapter, pickAdapter, _clearAdaptersForTesting } from './lang-adapter/registry.js';
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

// ── Transitional adapter exports ──────────────────────────────────
//
// `pythonGraphAdapter` and `rustGraphAdapter` are still in the engine
// at PR 1b. They publish through this barrel so cross-package tests
// (in @opensip-tools/graph-typescript) can exercise the registry
// against three live adapters without deep-importing engine internals.
// PR 2 / PR 3 relocate these adapters into their own packages, at
// which point these exports drain from this barrel.
export { pythonGraphAdapter } from './lang-python/index.js';
export { rustGraphAdapter } from './lang-rust/index.js';
export type { PythonParsedProject } from './lang-python/parse.js';
export type { RustParsedProject } from './lang-rust/parse.js';
export { pythonRuleHints } from './lang-python/rule-hints.js';
export { rustRuleHints } from './lang-rust/rule-hints.js';

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
