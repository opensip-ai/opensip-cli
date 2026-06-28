/**
 * `who_calls` — bounded reverse call walk (ADR-0084, Task 4.2).
 *
 * Resolves the input `symbolId` via the port (unknown id → structured error),
 * then runs the shared {@link boundedBfs} over the reverse-call adjacency
 * snapshot. Cycle-safe, depth-bounded (default 5, max 5), node-capped with a
 * `truncated` flag. Returns the `{ data, freshness, truncated? }` envelope.
 */

import { registerCallWalkTool } from './call-walk-tool.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerWhoCalls(server: McpStdioServer, deps: McpToolDeps): void {
  registerCallWalkTool(server, deps.graph, {
    name: 'who_calls',
    title: 'Who calls a symbol',
    description:
      'Find the callers of a symbol (reverse call graph), out to `depth` levels (default 5, ' +
      'max 5). Pass a symbolId from search_symbols/get_symbol. Edges are body-hash-union ' +
      '(twin-aware): a result is reachable through any occurrence sharing a body. Large fan-in ' +
      'is node-capped with truncated:true.',
    graph: (port) => port.callerGraph(),
  });
}
