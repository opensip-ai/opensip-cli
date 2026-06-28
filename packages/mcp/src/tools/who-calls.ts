/**
 * `who_calls` — bounded reverse call walk (ADR-0084, Task 4.2).
 *
 * Resolves the input `symbolId` via the port (unknown id → structured error),
 * then runs the shared {@link boundedBfs} over the reverse-call adjacency
 * snapshot. Cycle-safe, depth-bounded (default 5, max 5), node-capped with a
 * `truncated` flag. Returns the `{ data, freshness, truncated? }` envelope.
 */

import { boundedBfs, MAX_WALK_NODES } from './graph-walk.js';
import { depth as depthSchema, symbolId as symbolIdSchema } from './schemas.js';
import { errorResult, failure, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerWhoCalls(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'who_calls',
    {
      title: 'Who calls a symbol',
      description:
        'Find the callers of a symbol (reverse call graph), out to `depth` levels (default 5, ' +
        'max 5). Pass a symbolId from search_symbols/get_symbol. Edges are body-hash-union ' +
        '(twin-aware): a result is reachable through any occurrence sharing a body. Large fan-in ' +
        'is node-capped with truncated:true.',
      inputSchema: {
        symbolId: symbolIdSchema(),
        depth: depthSchema(),
      },
    },
    ({ symbolId, depth }) => {
      const resolved = deps.graph.resolveSymbolId(symbolId);
      if (!resolved.ok) return errorResult(resolved.error);
      const startRef = resolved.value.data;
      if (startRef === undefined) {
        return failure(
          'symbol-not-found',
          `Unknown symbolId "${symbolId}". Obtain a valid symbolId from search_symbols or get_symbol.`,
        );
      }
      const graph = deps.graph.callerGraph();
      if (!graph.ok) return errorResult(graph.error);
      const { data: snapshot, freshness } = graph.value;
      const walk = boundedBfs(snapshot.edges, startRef.bodyHash, {
        depth,
        cap: MAX_WALK_NODES,
      });
      const callers = walk.order
        .map((hash) => snapshot.resolve(hash))
        .filter((ref) => ref !== undefined);
      return jsonResult({
        data: callers,
        freshness,
        ...(walk.truncated ? { truncated: true } : {}),
      });
    },
  );
}
