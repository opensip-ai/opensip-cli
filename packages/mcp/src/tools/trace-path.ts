/**
 * `trace_path` — shortest forward call path `from → … → to`.
 *
 * Routes through one `GraphReadPort.traverse` call so path, context, and
 * freshness share a single immutable generation.
 */

import { depth as depthSchema, symbolId as symbolIdSchema } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

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
    async ({ fromSymbolId, toSymbolId, depth }) => {
      const outcome = await deps.graph.traverse({
        direction: 'path',
        startSymbolId: fromSymbolId,
        goalSymbolId: toSymbolId,
        depth,
        identity: 'occurrence',
      });
      if (!outcome.ok) return errorResult(outcome.error);
      const { data, context, freshness, coverage } = outcome.value;
      return jsonResult({
        data: {
          found: data.found,
          path: data.path ?? [],
        },
        context,
        freshness,
        coverage,
      });
    },
  );
}
