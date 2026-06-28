/**
 * `trace_path` — shortest forward call path `from → … → to` (ADR-0084, Task 4.2).
 *
 * The third caller of the shared {@link boundedBfs}: resolves both symbolIds via
 * the port, runs a goal-directed BFS over the forward-call adjacency, and (on a
 * hit) reconstructs the path via the BFS parent map. No path within the depth
 * bound returns `{ found: false, path: [] }` — not an error.
 */

import { boundedBfs, MAX_WALK_NODES, reconstructPath } from './graph-walk.js';
import { errorResult, failure, jsonResult } from './tool-result.js';
import { depth as depthSchema, symbolId as symbolIdSchema } from './schemas.js';

import type { PathTraceDto } from '../graph-read-port.js';
import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';
import type { SymbolRef } from '../symbol-dto.js';

export function registerTracePath(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'trace_path',
    {
      title: 'Trace a call path',
      description:
        'Find a forward call path from one symbol to another (fromSymbolId reaches toSymbolId ' +
        'through calls), within `depth` levels (default 5, max 5). Pass symbolIds from ' +
        'search_symbols/get_symbol. Returns the ordered path, or { found: false } when none ' +
        'exists within the bound.',
      inputSchema: {
        fromSymbolId: symbolIdSchema(),
        toSymbolId: symbolIdSchema(),
        depth: depthSchema(),
      },
    },
    ({ fromSymbolId, toSymbolId, depth }) => {
      const from = deps.graph.resolveSymbolId(fromSymbolId);
      if (!from.ok) return errorResult(from.error);
      const to = deps.graph.resolveSymbolId(toSymbolId);
      if (!to.ok) return errorResult(to.error);
      const fromRef = from.value.data;
      const toRef = to.value.data;
      if (fromRef === undefined || toRef === undefined) {
        const missing = fromRef === undefined ? fromSymbolId : toSymbolId;
        return failure(
          'symbol-not-found',
          `Unknown symbolId "${missing}". Obtain valid symbolIds from search_symbols or get_symbol.`,
        );
      }
      const graph = deps.graph.calleeGraph();
      if (!graph.ok) return errorResult(graph.error);
      const { data: snapshot, freshness } = graph.value;
      const walk = boundedBfs(snapshot.edges, fromRef.bodyHash, {
        depth,
        cap: MAX_WALK_NODES,
        goal: toRef.bodyHash,
      });
      if (!walk.foundGoal) {
        const data: PathTraceDto = { found: false, path: [] };
        return jsonResult({ data, freshness, ...(walk.truncated ? { truncated: true } : {}) });
      }
      const path: SymbolRef[] = reconstructPath(walk.parents, fromRef.bodyHash, toRef.bodyHash)
        .map((hash) => snapshot.resolve(hash))
        .filter((ref): ref is SymbolRef => ref !== undefined);
      const data: PathTraceDto = { found: true, path };
      return jsonResult({ data, freshness });
    },
  );
}
