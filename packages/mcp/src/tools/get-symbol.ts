/**
 * `get_symbol` — resolve a symbol by file + line.
 */

import {
  filePath as filePathSchema,
  line as lineSchema,
  strictInput,
  symbolDetail,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGetSymbol(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_symbol',
    {
      title: 'Get symbol by location',
      description:
        'Resolve the function/method declared at a project-relative file + line into a stable ' +
        'symbolId ("<filePath>:<line>:<column>") + bodyHash. On ambiguity (nested declarations ' +
        'enclosing the line) returns a candidate list — never a silent pick. Use the returned ' +
        'symbolId with who_calls, callees_of, blast_radius, or trace_path.',
      inputSchema: strictInput({
        file: filePathSchema(),
        line: lineSchema(),
        detail: symbolDetail(),
      }),
    },
    async ({ file, line, detail }, request) => {
      const outcome = await deps.graph.symbolAtLocation(file, line, detail, request?.signal);
      if (!outcome.ok) return errorResult(outcome.error);
      const { data, freshness, context, coverage } = outcome.value;
      const { candidates, entity } = data;
      if (candidates.length === 0) {
        const message =
          `No symbol declaration encloses ${file}:${String(line)}. ` +
          (freshness.fresh
            ? 'Check the file/line, or use search_symbols by name.'
            : 'The catalog is stale/missing — run refresh_graph, then retry.');
        return jsonResult({
          data: candidates,
          context,
          freshness,
          coverage,
          found: false,
          error: {
            code: 'symbol-not-found',
            message,
          },
        });
      }
      if (candidates.length === 1) {
        if (detail === 'summary') {
          return jsonResult({ data: candidates[0], context, freshness, coverage });
        }
        if (entity === null || entity === undefined) {
          return jsonResult({
            data: null,
            context,
            freshness,
            coverage,
            found: false,
            error: {
              code: 'entity-not-found',
              message:
                'The resolved symbol is not present in the captured graph generation. ' +
                'Retry get_symbol and inspect catalog identity/freshness.',
            },
          });
        }
        return jsonResult({ data: entity, context, freshness, coverage });
      }
      return jsonResult({ ambiguous: true, candidates, context, freshness, coverage });
    },
  );
}
