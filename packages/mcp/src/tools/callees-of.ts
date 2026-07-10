/**
 * `callees_of` — bounded forward call walk.
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
      'max 5). Pass a symbolId from search_symbols/get_symbol. Phase 1 walks body-twin-union ' +
      'adjacency; results include project/catalog context and coverage (walk-node-cap).',
    direction: 'callees',
  });
}
