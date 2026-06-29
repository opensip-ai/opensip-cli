/**
 * Shared registration for bounded call-graph walk tools.
 *
 * `who_calls` and `callees_of` differ only by metadata and adjacency direction;
 * resolving `symbolId`, enforcing the bounded BFS, freshness propagation, and
 * `truncated` shaping belong in one implementation.
 */

import { boundedBfs, MAX_WALK_NODES } from './graph-walk.js';
import { depth as depthSchema, symbolId as symbolIdSchema } from './schemas.js';
import { errorResult, failure, jsonResult } from './tool-result.js';

import type { GraphReadPort } from '../graph-read-port.js';
import type { McpStdioServer } from '../server.js';
import type { SymbolRef } from '../symbol-dto.js';

export interface CallWalkToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly graph: (port: GraphReadPort) => ReturnType<GraphReadPort['callerGraph']>;
}

export function registerCallWalkTool(
  server: McpStdioServer,
  graphPort: GraphReadPort,
  spec: CallWalkToolSpec,
): void {
  server.register(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: {
        symbolId: symbolIdSchema(),
        depth: depthSchema(),
      },
    },
    ({ symbolId, depth }) => {
      const resolved = graphPort.resolveSymbolId(symbolId);
      if (!resolved.ok) return errorResult(resolved.error);
      const startRef = resolved.value.data;
      if (startRef === undefined) {
        return failure(
          'symbol-not-found',
          `Unknown symbolId "${symbolId}". Obtain a valid symbolId from search_symbols or get_symbol.`,
        );
      }
      const graph = spec.graph(graphPort);
      if (!graph.ok) return errorResult(graph.error);
      const { data: snapshot, freshness } = graph.value;
      const walk = boundedBfs(snapshot.edges, startRef.bodyHash, {
        depth,
        cap: MAX_WALK_NODES,
      });
      const data = walk.order.map((hash) => snapshot.resolve(hash)).filter(isSymbolRef);
      return jsonResult({
        data,
        freshness,
        ...(walk.truncated ? { truncated: true } : {}),
      });
    },
  );
}

function isSymbolRef(ref: SymbolRef | undefined): ref is SymbolRef {
  return ref !== undefined;
}
