/**
 * `blast_radius` — change-impact score for a symbol (ADR-0084, Task 4.3).
 *
 * Delegates to `graphPort.blast()`, which reuses graph's single canonical
 * `buildFeatures(['blast'])` scoring site — so the numbers never diverge from
 * `opensip graph`. NOT a re-implemented BFS. Returns `{ data, freshness }` with
 * direct/transitive caller counts + the composite score.
 */

import { errorResult, failure, jsonResult } from './tool-result.js';
import { symbolId as symbolIdSchema } from './schemas.js';

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
        'uses. Pass a symbolId from search_symbols/get_symbol.',
      inputSchema: {
        symbolId: symbolIdSchema(),
      },
    },
    ({ symbolId }) => {
      const outcome = deps.graph.blast(symbolId);
      if (!outcome.ok) return errorResult(outcome.error);
      const { data, freshness } = outcome.value;
      if (data === undefined) {
        return failure(
          'blast-unavailable',
          freshness.fresh
            ? `No blast score for symbolId "${symbolId}" — check the id via search_symbols/get_symbol.`
            : 'The catalog is stale/missing — run refresh_graph, then retry.',
        );
      }
      return jsonResult({ data, freshness });
    },
  );
}
