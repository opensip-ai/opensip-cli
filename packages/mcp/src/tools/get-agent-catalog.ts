/**
 * `get_agent_catalog` — the self-describing OpenSIP command catalog (ADR-0084,
 * Task 4.5).
 *
 * Reads `resultsPort.agentCatalog()` ONLY — never invokes a tool. Highlights the
 * result-first workflow: an agent inspects parent execution context
 * (`list_execution_runs` / `show_execution_run`) or replayable Tool Session
 * findings (`get_latest_findings` / `show_run` / `list_runs`) before re-running.
 */

import { strictInput } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGetAgentCatalog(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_agent_catalog',
    {
      title: 'OpenSIP agent command catalog',
      description:
        'The self-describing catalog of OpenSIP commands an agent can run. Before re-running ' +
        'for existing or prior evidence, ' +
        'use list_execution_runs/show_execution_run for persisted audit or suite parent ' +
        'execution context, and use get_latest_findings/show_run/list_runs for replayable ' +
        'Tool Session results, scores, errors, warnings, or findings. These read persisted ' +
        'evidence and never re-run fit/graph/yagni/sim, an audit, or a suite. Do not grep ' +
        '.runtime/logs, read datastore.sqlite directly, or re-run a CLI tool to answer ' +
        'stored-result questions.',
      inputSchema: strictInput({}),
    },
    () => {
      const outcome = deps.results.agentCatalog();
      if (!outcome.ok) return errorResult(outcome.error);
      const catalog = outcome.value;
      const surface = deps.mcpSurface?.();
      if (surface === undefined) return jsonResult(catalog);
      // Additive MCP-only overlay — never forced into contracts AgentCatalog.
      return jsonResult({
        ...(catalog as unknown as Record<string, unknown>),
        mcp: {
          version: surface.version,
          surfaceEpoch: surface.surfaceEpoch,
          toolNames: surface.toolNames,
          toolCount: surface.toolCount,
          mutationPosture: surface.mutationPosture,
          project: {
            root: surface.projectRoot,
            scope: surface.projectScope,
          },
        },
      });
    },
  );
}
