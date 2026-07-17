/**
 * `list_execution_runs` — bounded canonical parent execution history.
 *
 * Reads `resultsPort.listExecutionRuns()` only. This is the audit/suite parent
 * ledger, not the legacy Tool Session replay surface exposed by `list_runs`.
 */

import { limit as limitSchema, strictInput } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerListExecutionRuns(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'list_execution_runs',
    {
      title: 'List OpenSIP execution runs',
      description:
        'List bounded, newest-first existing canonical parent execution Runs for audit and suite ' +
        'context. Each row is the same parent Run DTO used by `opensip runs list --json` ' +
        'and points to show_execution_run for ordered step detail. This is distinct from ' +
        'list_runs, which lists replayable Tool Sessions. Reads persisted evidence only ' +
        'and never re-runs an analysis, audit, or suite. Do not inspect .runtime/logs or ' +
        'datastore.sqlite directly.',
      inputSchema: strictInput({
        limit: limitSchema(),
      }),
    },
    ({ limit }) => {
      const outcome = deps.results.listExecutionRuns(limit === undefined ? {} : { limit });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
