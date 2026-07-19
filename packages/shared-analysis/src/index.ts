/**
 * @opensip-cli/shared-analysis — shared cross-tool analysis RUNTIME.
 *
 * Layer-3 substrate extracted out of @opensip-cli/contracts (Plan 09 Phase 7):
 * contracts stays the frozen type/constant/schema facade; the executable
 * cross-tool analysis engines live here so tool engines (graph, fitness, mcp)
 * and the CLI composition root share one implementation without inflating the
 * contract layer with runtime. Types, zod schemas, and error classes for these
 * surfaces remain in @opensip-cli/contracts — import them from there.
 *
 * Owns:
 * - the changed→impact compute engine over the GraphCatalog contract
 *   (sync + cooperative async + reusable generation index, ADR-0085);
 * - review-brief risk derivation, ordering, and correlation grouping;
 * - agent-catalog content build + transport-parity assembly (ADR-0084)
 *   plus the host-support and target-convention projections.
 *
 * Must never import cli, a tool engine (fitness/graph/simulation/yagni/mcp),
 * or a check/adapter pack — enforced by the
 * `shared-analysis-no-tool-or-cli-edges` dependency-cruiser rule.
 */

// Changed→impact compute engine (ADR-0085). Model types + error classes stay
// in @opensip-cli/contracts.
export {
  buildComputeImpactIndex,
  computeImpact,
  computeImpactAsync,
  computeImpactCatalogGenerationIdentity,
  computeImpactIndexMatchesCatalog,
} from './graph-impact-compute.js';

// Review-brief derivation runtime. The ReviewBrief type family, the version
// constant, and every reviewBrief*Schema zod schema stay in contracts.
export {
  buildReviewBriefBaselineDelta,
  buildReviewBriefRecommendedActions,
  compareReviewBriefRisks,
  deriveReviewBriefVerdict,
  pushReviewBriefDegradation,
  reviewBriefBaselineState,
  reviewBriefBlastRadius,
  signalToReviewBriefRisk,
} from './review-brief.js';
export {
  buildReviewBriefCorrelations,
  reviewBriefCorrelationKeys,
  reviewBriefEntities,
} from './review-brief-correlation.js';

// Agent command catalog runtime (ADR-0084) — the content builder + curated
// entry points the host `agent-catalog` command renders and @opensip-cli/mcp
// serves. The AgentCatalog / AgentCatalogBuildInput / CommandTier types stay
// in contracts.
export {
  agentCatalogOverlayKeys,
  agentCatalogPlatformEntryPoints,
  assertAgentCatalogOverlayKeys,
  buildAgentCatalog,
} from './agent-catalog.js';
export {
  assembleAgentCatalog,
  projectAgentCatalogRuntimeFacts,
  type AgentCatalogAssemblyInput,
  type AgentCatalogRuntimeFacts,
} from './agent-catalog-assembly.js';
export { summarizeTargetConventions } from './target-conventions.js';
// Host-support projection (Plan 02, macOS GA): the single core→contracts
// mapper both CLI and MCP call, so their hostSupport output is byte-identical
// for identical process facts. The AgentHostSupport type stays in contracts.
export { hostSupportFromRuntimeProjection } from './host-support.js';
