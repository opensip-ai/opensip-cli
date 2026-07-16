/** `get_file_context` — bounded inventory metadata for one exact path. */

import { filePath, strictInput } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpStdioServer } from '../server.js';
import type { McpToolDeps } from './types.js';

export function registerGetFileContext(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_file_context',
    {
      title: 'Get project file context',
      description:
        'Return bounded inventory metadata, roles, targets, package context, coverage, and ' +
        'freshness for one project-relative file. Unknown, excluded, and unavailable are ' +
        'distinct states; no source text is returned.',
      inputSchema: strictInput({ file: filePath() }),
    },
    async ({ file }, request) => {
      const outcome = await deps.codebase.fileContext(file, request?.signal);
      return outcome.ok ? jsonResult(outcome.value) : errorResult(outcome.error);
    },
  );
}
