/**
 * MCP graph-adapter registrar (Task 6.1 step 6 — Scope).
 *
 * `registerMcpGraphAdapter` mirrors graph's own `registerGraphAdapter`: a routed
 * capability contribution is registered into THIS run's scope-owned adapter
 * registry (`scope.graph.adapters`, reached via `currentAdapterRegistry()`).
 * Because graph's `contributeScope` runs for every bundled tool, that registry
 * exists under `opensip mcp` even though the dispatched tool is `mcp` — the
 * wiring a recent core fix routes through MCP's own domain.
 */

import { applyToolContributeScope, RunScope, runWithScopeSync } from '@opensip-cli/core';
import { currentAdapterRegistry, graphTool } from '@opensip-cli/graph';
import { typescriptGraphAdapter } from '@opensip-cli/graph-typescript';
import { describe, expect, it } from 'vitest';

import { registerMcpGraphAdapter } from '../register-mcp-graph-adapters.js';

/** A scope carrying graph's contributed subscope (so `scope.graph.adapters` exists). */
function graphScope(): RunScope {
  const scope = new RunScope();
  applyToolContributeScope(scope, graphTool);
  return scope;
}

describe('registerMcpGraphAdapter', () => {
  it('registers a routed graph adapter into the scope-owned adapter registry', () => {
    const scope = graphScope();
    runWithScopeSync(scope, () => {
      expect(currentAdapterRegistry().size).toBe(0);
      // The host routes the contribution (already shape-checked) through this registrar.
      registerMcpGraphAdapter(typescriptGraphAdapter);
      expect(currentAdapterRegistry().size).toBe(1);
      expect(currentAdapterRegistry().getById('typescript')).toBeDefined();
    });
  });

  it('routes through the scope active at registration time (no module singleton)', () => {
    // A first scope gets the adapter; a second, independent scope does NOT —
    // proving registration targets the active scope's registry, not a global.
    const first = graphScope();
    runWithScopeSync(first, () => registerMcpGraphAdapter(typescriptGraphAdapter));

    const second = graphScope();
    runWithScopeSync(second, () => {
      expect(currentAdapterRegistry().size).toBe(0);
    });
    runWithScopeSync(first, () => {
      expect(currentAdapterRegistry().size).toBe(1);
    });
  });
});
