/**
 * @opensip-tools/graph — public barrel.
 *
 * The graph tool implements a strict six-stage pipeline:
 * discover → inventory → edges → indexes → rules → render.
 * Per spec docs/plans/graph-tool-v2-design.md.
 */

export { graphTool } from './tool.js';
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
export type { EdgeResolver, ResolverContext } from './pipeline/edge-resolvers/types.js';
export type { InventoryVisitor, VisitorContext } from './pipeline/inventory-visitors/types.js';
