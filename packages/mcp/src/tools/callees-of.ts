/**
 * `callees_of` — bounded forward call walk (ADR-0084, Task 4.2).
 *
 * The forward twin of `who_calls`: resolves `symbolId` via the port, then runs
 * the shared {@link boundedBfs} over the forward-call adjacency snapshot. Same
 * bounds (depth default 5, max 5; node cap → `truncated`) and same
 * `{ data, freshness, truncated? }` envelope.
 */

import { boundedBfs, MAX_WALK_NODES } from './graph-walk.js';
import { depth as depthSchema, symbolId as symbolIdSchema } from './schemas.js';
import { errorResult, failure, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerCalleesOf(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'callees_of',
    {
      title: 'Callees of a symbol',
      description:
        'Find the symbols a symbol calls (forward call graph), out to `depth` levels (default 5, ' +
        'max 5). Pass a symbolId from search_symbols/get_symbol. Edges are body-hash-union ' +
        '(twin-aware). Large fan-out is node-capped with truncated:true.',
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
      const graph = deps.graph.calleeGraph();
      if (!graph.ok) return errorResult(graph.error);
      const { data: snapshot, freshness } = graph.value;
      const walk = boundedBfs(snapshot.edges, startRef.bodyHash, {
        depth,
        cap: MAX_WALK_NODES,
      });
      const callees = walk.order
        .map((hash) => snapshot.resolve(hash))
        .filter((ref) => ref !== undefined);
      return jsonResult({
        data: callees,
        freshness,
        ...(walk.truncated ? { truncated: true } : {}),
      });
    },
  );
}
