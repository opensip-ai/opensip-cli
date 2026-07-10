/**
 * `blast_radius` — change-impact score for a symbol.
 */

import { symbolId as symbolIdSchema } from './schemas.js';
import { errorResult, failure, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerBlastRadius(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'blast_radius',
    {
      title: 'Blast radius of a symbol',
      description:
        'Change-impact score for a symbol: direct (depth-1) callers, transitive callers, and a ' +
        'composite blast score (direct + 0.5×transitive) — the same scoring `opensip graph` ' +
        'uses (body-twin-union identity). Pass a symbolId from search_symbols/get_symbol.',
      inputSchema: {
        symbolId: symbolIdSchema(),
      },
    },
    async ({ symbolId }) => {
      const outcome = await deps.graph.blast(symbolId);
      if (!outcome.ok) return errorResult(outcome.error);
      const { data, freshness, context, coverage } = outcome.value;
      if (data === undefined) {
        return failure(
          'blast-unavailable',
          freshness.fresh
            ? `No blast score for symbolId "${symbolId}" — check the id via search_symbols/get_symbol.`
            : 'The catalog is stale/missing — run refresh_graph, then retry.',
        );
      }
      return jsonResult({ data, context, freshness, coverage });
    },
  );
}
