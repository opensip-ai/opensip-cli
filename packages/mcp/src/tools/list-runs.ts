/**
 * `list_runs` — lean stored-run pointers (ADR-0084, Task 4.5).
 *
 * Reads `resultsPort.listRuns()` ONLY — replay of persisted sessions, never a
 * re-run. Returns a menu of `RunSummary` rows, each with the `opensip sessions
 * show …` command + MCP follow-up via `show_run` / `get_latest_findings`.
 */

import { z } from 'zod';

import { errorResult, jsonResult, unknownToolError } from './tool-result.js';
import { limit as limitSchema, toolId as toolIdSchema } from './schemas.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerListRuns(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'list_runs',
    {
      title: 'List OpenSIP runs',
      description:
        'List recent stored OpenSIP runs (fit/graph/yagni/sim) as lean pointers — id, tool, ' +
        'timing, score/passed, and the replay command. Drill into one with show_run, or jump to ' +
        'a tool’s current findings with get_latest_findings. Replays persisted sessions; ' +
        'never re-runs a tool. Filter by `tool`, cap with `limit`.',
      inputSchema: {
        tool: toolIdSchema().optional(),
        limit: limitSchema(),
        summaryOnly: z.boolean().optional(),
      },
    },
    ({ tool, limit, summaryOnly }) => {
      if (tool !== undefined && !deps.validToolIds.has(tool)) {
        return unknownToolError(tool, deps.validToolIds);
      }
      const outcome = deps.results.listRuns({
        ...(tool === undefined ? {} : { tool }),
        ...(limit === undefined ? {} : { limit }),
        ...(summaryOnly === undefined ? {} : { summaryOnly }),
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult({ runs: outcome.value });
    },
  );
}
