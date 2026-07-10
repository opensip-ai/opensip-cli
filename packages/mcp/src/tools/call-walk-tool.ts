/**
 * Shared registration for bounded call-graph walk tools.
 *
 * `who_calls` and `callees_of` route through one `GraphReadPort.traverse` call
 * so a single immutable generation is captured for the whole walk.
 */

import { depth as depthSchema, symbolId as symbolIdSchema } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { GraphReadPort } from '../graph-read-port.js';
import type { McpStdioServer } from '../server.js';

export interface CallWalkToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly direction: 'callers' | 'callees';
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
    async ({ symbolId, depth }) => {
      const outcome = await graphPort.traverse({
        direction: spec.direction,
        startSymbolId: symbolId,
        depth,
        identity: 'occurrence',
      });
      if (!outcome.ok) return errorResult(outcome.error);
      const { data, context, freshness, coverage, page } = outcome.value;
      if (!data.found && data.nodes.length === 0) {
        // Distinguish missing start from empty walk: check context + empty nodes.
        // When catalog loaded but start unknown, nodes is empty and found is false.
        return jsonResult({
          data: data.nodes.map((n) => n.symbol),
          context,
          freshness,
          coverage,
          page,
        });
      }
      return jsonResult({
        data: data.nodes.map((n) => n.symbol),
        context,
        freshness,
        coverage,
        page,
      });
    },
  );
}
