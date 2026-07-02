/**
 * `get_latest_findings` — the behavior-critical, result-first tool (ADR-0084,
 * Task 4.5).
 *
 * Reads `resultsPort.latestFindings()` ONLY — replays the most recent stored run
 * for `tool`, severity/limit-filtered. Its description STEERS agents here before
 * re-running OpenSIP (the verbatim instruction below is a product contract).
 * Validates `tool` against the live registry → structured unknown-tool error.
 */

import {
  limit as limitSchema,
  severity as severitySchema,
  toolId as toolIdSchema,
} from './schemas.js';
import { errorResult, jsonResult, unknownToolError } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGetLatestFindings(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_latest_findings',
    {
      title: 'Latest findings for a tool',
      description:
        'Use this OpenSIP MCP result tool first for existing or prior fit/graph/yagni/sim ' +
        'errors, warnings, findings, scores, sessions, last-run, or current-finding questions. ' +
        'Gets findings from the most recent stored run of a tool, filterable by `severity` ' +
        '(errors/warnings/all) and capped with `limit`. Replays the persisted session and ' +
        'never re-runs fit/graph/yagni/sim. Do not grep .runtime/logs, read datastore.sqlite ' +
        'directly, or re-run a CLI tool to answer stored-result questions.',
      inputSchema: {
        tool: toolIdSchema(),
        severity: severitySchema(),
        limit: limitSchema(),
      },
    },
    async ({ tool, severity, limit }) => {
      if (!deps.validToolIds.has(tool)) return unknownToolError(tool, deps.validToolIds);
      const outcome = await deps.results.latestFindings({
        tool,
        ...(severity === undefined ? {} : { severity }),
        ...(limit === undefined ? {} : { limit }),
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
