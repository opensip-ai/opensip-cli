/**
 * `show_execution_run` — one exact parent Run plus a bounded RunStep page.
 *
 * Reads `resultsPort.showExecutionRun()` only. Linked Tool Sessions remain
 * follow-up references; their payloads are deliberately not hydrated.
 */

import {
  executionRunId,
  executionRunOffset,
  limit as limitSchema,
  strictInput,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerShowExecutionRun(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'show_execution_run',
    {
      title: 'Show an OpenSIP execution run',
      description:
        'Read one exact existing canonical parent execution Run and a bounded, ordered RunStep page. ' +
        'The runId is exact: this tool does not resolve "latest", names, Tool Session ids, ' +
        'or fuzzy matches. Linked Sessions are returned only as follow-up ids and `opensip ' +
        'sessions show` commands; payloads are not hydrated. Reads persisted evidence only ' +
        'and never re-runs an analysis, audit, or suite. Do not inspect .runtime/logs or ' +
        'datastore.sqlite directly.',
      inputSchema: strictInput({
        runId: executionRunId(),
        offset: executionRunOffset(),
        limit: limitSchema(),
      }),
    },
    ({ runId, offset, limit }) => {
      const outcome = deps.results.showExecutionRun({
        runId,
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
