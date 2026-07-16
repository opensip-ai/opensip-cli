/**
 * `who_calls` — bounded reverse call walk (occurrence-precise by default).
 */

import { registerCallWalkTool, type CallWalkToolSpec } from './call-walk-tool.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const WHO_CALLS_SPEC: CallWalkToolSpec = {
  name: 'who_calls',
  title: 'Who calls a symbol',
  description:
    'Find the callers of a symbol (reverse call graph), out to `depth` levels (default 5, ' +
    'max 5; hard walk-node cap 2000). detail defaults to nodes (paged concrete callers). ' +
    'Pass detail=summary for counts only, or detail=groups with groupBy=package|file for ' +
    'group pages without member nodes. Default identity is occurrence-precise; pass ' +
    'identity=body-twin-union for endpoint-filtered twin reachability. Filters apply to both ' +
    'edge endpoints before projection. Pass symbolId from search_symbols/get_symbol.',
  direction: 'callers',
};

export function registerWhoCalls(server: McpStdioServer, deps: McpToolDeps): void {
  registerCallWalkTool(server, deps.graph, WHO_CALLS_SPEC);
}
