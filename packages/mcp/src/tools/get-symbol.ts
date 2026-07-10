/**
 * `get_symbol` — resolve a symbol by file + line.
 */

import { filePath as filePathSchema, line as lineSchema, strictInput } from './schemas.js';
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
      }),
    },
    async ({ file, line }) => {
      const outcome = await deps.graph.findBySpan(file, line);
      if (!outcome.ok) return errorResult(outcome.error);
      const { data: candidates, freshness, context, coverage } = outcome.value;
      if (candidates.length === 0) {
        const message =
          `No symbol declaration encloses ${file}:${String(line)}. ` +
          (freshness.fresh
            ? 'Check the file/line, or use search_symbols by name.'
            : 'The catalog is stale/missing — run refresh_graph, then retry.');
        return jsonResult({
          ...outcome.value,
          found: false,
          error: {
            code: 'symbol-not-found',
            message,
          },
        });
      }
      if (candidates.length === 1) {
        return jsonResult({ data: candidates[0], context, freshness, coverage });
      }
      return jsonResult({ ambiguous: true, candidates, context, freshness, coverage });
    },
  );
}
