// @fitness-ignore-file hot-paths-require-spans -- Registration wiring, not a runtime hot path: this registrar runs once per adapter at scope build (it just routes the contribution into the scope-owned registry). It mirrors graph's own internal registerGraphAdapter; the graph engine owns the span boundary and traces adapter work centrally per pipeline stage.
/**
 * MCP's registrar for its `mcp-graph-adapter` capability domain (ADR-0084).
 *
 * Mirrors graph's `registerGraphAdapter` (graph `tool.ts`): a routed
 * contribution (already shape-checked against the domain's `requiredKeys: ['id']`
 * by the host) is registered into THIS run's scope-owned adapter registry.
 *
 * Why this works: graph's `contributeScope` runs for EVERY bundled tool (the host
 * loops all contributing tools when building the RunScope), so `scope.graph.adapters`
 * exists under `opensip mcp` even though the dispatched tool is `mcp`.
 * `currentAdapterRegistry()` resolves that registry; MCP declares its OWN domain id
 * (`mcp-graph-adapter`) with `markerKind: 'graph-adapter'`, so the host's
 * bundled-pack lookup (keyed by markerKind) loads the same `graph-*` adapter packs
 * under MCP's domain and routes each contribution through this registrar.
 */
import { currentAdapterRegistry, type GraphLanguageAdapter } from '@opensip-cli/graph';

import type { CapabilityRegistrar } from '@opensip-cli/core';

export const registerMcpGraphAdapter: CapabilityRegistrar = (contribution) => {
  currentAdapterRegistry().register(contribution as GraphLanguageAdapter);
};
