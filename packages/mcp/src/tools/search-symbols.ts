/**
 * `search_symbols` — name/substring symbol lookup.
 */

import { z } from 'zod';

import { query as querySchema, limit as limitSchema } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerSearchSymbols(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'search_symbols',
    {
      title: 'Search symbols',
      description:
        'Find functions/methods by name (case-insensitive substring). Returns symbolId ' +
        '("<filePath>:<line>:<column>") + bodyHash for each match — pass that symbolId to ' +
        'who_calls, callees_of, blast_radius, or trace_path. Results carry project/catalog ' +
        'context and freshness; a missing catalog returns empty data (run refresh_graph once).',
      inputSchema: {
        query: querySchema(),
        kind: z.string().min(1).max(32).optional(),
        limit: limitSchema(),
      },
    },
    async ({ query, kind, limit }) => {
      const outcome = await deps.graph.searchSymbols(query, {
        ...(limit === undefined ? {} : { limit }),
        ...(kind === undefined ? {} : { kind }),
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
