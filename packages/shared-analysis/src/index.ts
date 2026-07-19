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
