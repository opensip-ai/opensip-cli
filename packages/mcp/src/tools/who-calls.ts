/**
 * `who_calls` — bounded reverse call walk (occurrence-precise by default).
 */

import { registerCallWalkTool } from './call-walk-tool.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerWhoCalls(server: McpStdioServer, deps: McpToolDeps): void {
  registerCallWalkTool(server, deps.graph, {
    name: 'who_calls',
    title: 'Who calls a symbol',
    description:
      'Find the callers of a symbol (reverse call graph), out to `depth` levels (default 5, ' +
      'max 5; hard walk-node cap 2000). Default identity is occurrence-precise; pass ' +
      'identity=body-twin-union for endpoint-filtered twin reachability (never the global ' +
      'body-hash union). Filters (package/filePath/filePrefix/kinds/sourceScope/generated) ' +
      'apply to both edge endpoints before grouping. page.nextCursor is independent of ' +
      'coverage.truncated. Pass symbolId from search_symbols/get_symbol.',
    direction: 'callers',
  });
}
