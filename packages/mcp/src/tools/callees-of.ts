/**
 * `callees_of` — bounded forward call walk (ADR-0084, Task 4.2).
 *
 * The forward twin of `who_calls`: resolves `symbolId` via the port, then runs
 * the shared {@link boundedBfs} over the forward-call adjacency snapshot. Same
 * bounds (depth default 5, max 5; node cap → `truncated`) and same
 * `{ data, freshness, truncated? }` envelope.
 */

import { registerCallWalkTool } from './call-walk-tool.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerCalleesOf(server: McpStdioServer, deps: McpToolDeps): void {
  registerCallWalkTool(server, deps.graph, {
    name: 'callees_of',
    title: 'Callees of a symbol',
    description:
      'Find the symbols a symbol calls (forward call graph), out to `depth` levels (default 5, ' +
      'max 5). Pass a symbolId from search_symbols/get_symbol. Edges are body-hash-union ' +
      '(twin-aware). Large fan-out is node-capped with truncated:true.',
    graph: (port) => port.calleeGraph(),
  });
}
