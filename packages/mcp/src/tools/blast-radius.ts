/**
 * `blast_radius` — change-impact score for a symbol.
 */

import {
  pageFields,
  sourceFilterFields,
  strictInput,
  symbolId as symbolIdSchema,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

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
        'uses (body-twin-union identity). Members are filter-first and cursor-paged; the ' +
        'canonical score remains explicitly labelled when excluded twins contribute.',
      inputSchema: strictInput({
        symbolId: symbolIdSchema(),
        ...sourceFilterFields(),
        ...pageFields(),
      }),
    },
    async (args) => {
      const outcome = await deps.graph.blast(args.symbolId, {
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        filter: {
          packages: args.packages,
          filePath: args.filePath,
          filePrefix: args.filePrefix,
          kinds: args.kinds,
          visibilities: args.visibilities,
          sourceScope: args.sourceScope,
          generated: args.generated,
        },
      });
      if (!outcome.ok) return errorResult(outcome.error);
      const { data, freshness, context, coverage } = outcome.value;
      if (data === undefined) {
        const message = freshness.fresh
          ? `No blast score for symbolId "${args.symbolId}" — check the id via search_symbols/get_symbol.`
          : 'The catalog is stale/missing — run refresh_graph, then retry.';
        return jsonResult({
          ...outcome.value,
          data: null,
          found: false,
          error: { code: 'blast-unavailable', message },
        });
      }
      void context;
      void coverage;
      return jsonResult(outcome.value);
    },
  );
}
