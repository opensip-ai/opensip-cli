/**
 * `get_symbol` — resolve a symbol by file + line (ADR-0084, Task 4.1).
 *
 * Span-containment: every occurrence whose `[line, endLine]` span encloses the
 * requested line. The result is deterministic and NEVER a silent pick:
 *   - exactly one  → `{ data: SymbolRef, freshness }`
 *   - more than one → `{ ambiguous: true, candidates: SymbolRef[], freshness }`
 *     (the agent disambiguates by picking a `symbolId`)
 *   - none          → a structured `symbol-not-found` error
 *
 * Each `SymbolRef` carries the stable `symbolId` + `bodyHash`. Reads only
 * `graphPort` (no filesystem read — the `file` arg is matched against the
 * catalog's project-relative paths).
 */

import { errorResult, failure, jsonResult } from './tool-result.js';
import { filePath as filePathSchema, line as lineSchema } from './schemas.js';

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
      inputSchema: {
        file: filePathSchema(),
        line: lineSchema(),
      },
    },
    ({ file, line }) => {
      const outcome = deps.graph.findBySpan(file, line);
      if (!outcome.ok) return errorResult(outcome.error);
      const { data: candidates, freshness } = outcome.value;
      if (candidates.length === 0) {
        return failure(
          'symbol-not-found',
          `No symbol declaration encloses ${file}:${String(line)}. ` +
            (freshness.fresh
              ? 'Check the file/line, or use search_symbols by name.'
              : 'The catalog is stale/missing — run refresh_graph, then retry.'),
        );
      }
      if (candidates.length === 1) return jsonResult({ data: candidates[0], freshness });
      return jsonResult({ ambiguous: true, candidates, freshness });
    },
  );
}
