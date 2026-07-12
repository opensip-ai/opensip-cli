/**
 * `find_dead_code` — orphan (unreachable) symbols with filters + paging.
 */

import {
  compactDetail,
  exactFilePath,
  filePrefix,
  generatedPolicy,
  kinds,
  packageArray,
  pageFields,
  sourceScope,
  strictInput,
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
        'List symbols unreachable from any entry point (graph orphan-subtree rule). Default ' +
        'detail=summary returns total orphan count and reason/rule distributions without ' +
        'concrete rows. Pass detail=nodes for paged findings, or detail=groups with ' +
        'groupBy=package|file for group counts only. Filters apply BEFORE pagination. ' +
        'Reads the catalog only — no filesystem walk.',
      inputSchema: strictInput({
        packages: packageArray(),
        filePath: exactFilePath().optional(),
        filePrefix: filePrefix().optional(),
        kinds: kinds(),
        visibilities: visibilities(),
        sourceScope: sourceScope(),
        generated: generatedPolicy(),
        detail: compactDetail('summary'),
        ...pageFields(),
      }),
    },
    async (args) => {
      const outcome = await deps.graph.deadCode({
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        detail: args.detail ?? 'summary',
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
