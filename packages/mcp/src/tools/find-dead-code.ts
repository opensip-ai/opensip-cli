/**
 * `find_dead_code` — orphan (unreachable) symbols with filters + paging.
 */

import {
  exactFilePath,
  filePrefix,
  generatedPolicy,
  kinds,
  packageArray,
  pageFields,
  sourceScope,
  visibilities,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerFindDeadCode(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'find_dead_code',
    {
      title: 'Find dead code',
      description:
        'List symbols unreachable from any entry point (graph orphan-subtree rule). Filters ' +
        '(package/filePath/filePrefix/kinds/visibilities/sourceScope/generated) apply BEFORE ' +
        'pagination. Each finding carries symbolId + reason. page.nextCursor continues a full ' +
        'orphan evaluation; coverage.truncated is reserved for hard evaluation caps, not paging. ' +
        'Reads the catalog only — no filesystem walk.',
      inputSchema: {
        packages: packageArray(),
        filePath: exactFilePath().optional(),
        filePrefix: filePrefix().optional(),
        kinds: kinds(),
        visibilities: visibilities(),
        sourceScope: sourceScope(),
        generated: generatedPolicy(),
        ...pageFields(),
      },
    },
    async (args) => {
      const outcome = await deps.graph.deadCode({
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        filter: {
          packages: args.packages,
          filePath: args.filePath,
          filePrefix: args.filePrefix,
          kinds: args.kinds,
          visibilities: args.visibilities,
          sourceScope: args.sourceScope,
          generated: args.generated,
        },
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
