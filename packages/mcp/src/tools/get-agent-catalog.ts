/**
 * `get_agent_catalog` — the self-describing OpenSIP command catalog (ADR-0084,
 * Task 4.5).
 *
 * Reads `resultsPort.agentCatalog()` ONLY — never invokes a tool. Highlights the
 * result-first workflow: an agent inspects existing findings (get_latest_findings,
 * show_run, list_runs) before re-running anything.
 */

import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGetAgentCatalog(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_agent_catalog',
    {
      title: 'OpenSIP agent command catalog',
      description:
        'The self-describing catalog of OpenSIP commands an agent can run. Before re-running, ' +
        'use OpenSIP MCP result tools (get_latest_findings, show_run, list_runs) first for ' +
        'existing or prior results, scores, sessions, errors, warnings, or findings. They ' +
        'replay persisted sessions and never re-run fit/graph/yagni/sim. Do not grep ' +
        '.runtime/logs, read datastore.sqlite directly, or re-run a CLI tool to answer ' +
        'stored-result questions.',
    },
    () => {
      const outcome = deps.results.agentCatalog();
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
