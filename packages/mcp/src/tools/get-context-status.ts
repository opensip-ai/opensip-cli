/** `get_context_status` — exact parent Run manifest and pointer availability. */

import { contextFiles, strictInput, suiteRunId } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpStdioServer } from '../server.js';
import type { McpToolDeps } from './types.js';

export function registerGetContextStatus(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_context_status',
    {
      title: 'Get recorded agent task context',
      description:
        'Replay the latest project agent-context manifest or one exact Run ID and verify every ' +
        'recorded pointer without substituting a newer graph generation or snapshot. Pass the ' +
        'same explicit project-relative files used for the task to verify scope binding before ' +
        'deciding to rerun. Trust requires available status, matched file scope, ready manifest, ' +
        'and current, complete, uncapped required planes whose pointers remain available. This ' +
        'read never starts the suite or refreshes the graph.',
      inputSchema: strictInput({
        runId: suiteRunId().optional(),
        files: contextFiles().optional(),
      }),
    },
    async ({ runId, files }, request) => {
      const outcome = await deps.context.contextStatus(
        runId === undefined && files === undefined
          ? undefined
          : {
              ...(runId === undefined ? {} : { runId }),
              ...(files === undefined ? {} : { files }),
            },
        request?.signal,
      );
      return outcome.ok ? jsonResult(outcome.value) : errorResult(outcome.error);
    },
  );
}
