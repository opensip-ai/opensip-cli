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
