/**
 * `callees_of` — bounded forward call walk (occurrence-precise by default).
 */

import { registerCallWalkTool } from './call-walk-tool.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerCalleesOf(server: McpStdioServer, deps: McpToolDeps): void {
  registerCallWalkTool(server, deps.graph, {
    name: 'callees_of',
    title: 'Callees of a symbol',
    description:
      'Find the callees of a symbol (forward call graph), out to `depth` levels (default 5, ' +
      'max 5; hard walk-node cap 2000). Default identity is occurrence-precise; pass ' +
      'identity=body-twin-union for endpoint-filtered twin reachability. Filters apply to both ' +
      'edge endpoints before grouping. Unresolved reverse calls cannot be attributed to a ' +
      'requested target. Pass symbolId from search_symbols/get_symbol.',
    direction: 'callees',
  });
}
