/**
 * `search_symbols` — name/substring symbol lookup (ADR-0084, Task 4.1).
 *
 * Returns the shared `{ data, freshness, truncated? }` envelope every graph tool
 * reuses. Each result is a {@link SymbolRef} carrying the stable
 * `symbolId = "${filePath}:${line}:${column}"` + `bodyHash` — the identity all
 * downstream graph tools accept (never a bare name). Reads only `graphPort`.
 */

import { z } from 'zod';

import { errorResult, jsonResult } from './tool-result.js';
import { query as querySchema, limit as limitSchema } from './schemas.js';

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
        'who_calls, callees_of, blast_radius, or trace_path. Results carry a freshness verdict; ' +
        'a missing catalog returns empty data (run refresh_graph once to build it).',
      inputSchema: {
        query: querySchema(),
        kind: z.string().min(1).max(32).optional(),
        limit: limitSchema(),
      },
    },
    ({ query, kind, limit }) => {
      const opts = limit === undefined ? undefined : { limit };
      const outcome = deps.graph.searchSymbols(query, opts);
      if (!outcome.ok) return errorResult(outcome.error);
      const result = outcome.value;
      if (kind === undefined) return jsonResult(result);
      // Optional kind narrowing is applied post-hoc on the (already capped) page.
      const filtered = result.data.filter((ref) => ref.kind === kind);
      return jsonResult({ ...result, data: filtered });
    },
  );
}
