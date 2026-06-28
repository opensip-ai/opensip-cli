/**
 * `find_dead_code` — orphan (unreachable) symbols (ADR-0084, Task 4.3).
 *
 * Delegates to `graphPort.deadCode()`, backed by graph's `orphan-subtree` rule
 * (reachability from entry points) — NOT ad-hoc filesystem reachability. Returns
 * the `{ data, freshness, truncated? }` envelope; `limit` caps the result.
 */

import { limit as limitSchema } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerFindDeadCode(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'find_dead_code',
    {
      title: 'Find dead code',
      description:
        'List symbols unreachable from any entry point (the graph orphan-subtree rule). Each ' +
        'finding carries its symbolId + a reason. Reads the catalog only — no filesystem walk. ' +
        'Use `limit` to cap results.',
      inputSchema: {
        limit: limitSchema(),
      },
    },
    ({ limit }) => {
      const outcome = deps.graph.deadCode(limit);
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
