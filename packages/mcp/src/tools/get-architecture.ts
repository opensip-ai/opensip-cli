/**
 * `get_architecture` — compact codebase overview (ADR-0084, Task 4.3).
 *
 * Delegates to `graphPort.architectureSummary()`: function/edge counts,
 * languages, the top-coupled packages, and the highest-blast hotspots (graph's
 * canonical scoring). Capped via `limit`; carries `{ freshness }`.
 */

import { errorResult, jsonResult } from './tool-result.js';
import { limit as limitSchema } from './schemas.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGetArchitecture(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_architecture',
    {
      title: 'Architecture overview',
      description:
        'High-level shape of the codebase: function/edge counts, languages, the most-coupled ' +
        'packages, and the highest blast-radius hotspots. A cheap first call to orient before ' +
        'drilling in with who_calls/blast_radius. Use `limit` to cap rows.',
      inputSchema: {
        limit: limitSchema(),
      },
    },
    ({ limit }) => {
      const outcome = deps.graph.architectureSummary(limit);
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
