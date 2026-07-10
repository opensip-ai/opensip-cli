/**
 * `who_calls` — bounded reverse call walk.
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
      'max 5). Pass a symbolId from search_symbols/get_symbol. Phase 1 walks body-twin-union ' +
      'adjacency; results include project/catalog context and coverage (walk-node-cap).',
    direction: 'callers',
  });
}
