/**
 * `get_architecture` — labelled, bounded codebase orientation overview.
 */

import {
  exactFilePath,
  filePrefix,
  packageArray,
  pageFields,
  productionGeneratedPolicy,
  productionSourceScope,
  strictInput,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGetArchitecture(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_architecture',
    {
      title: 'Architecture overview',
      description:
        'Labelled orientation view: occurrence vs unique-body counts, resolved/unresolved call ' +
        'evidence with confidence/resolution distributions, top package call edges, blast ' +
        'hotspots (filtered before ranking), and bounded target convention counts when configured. ' +
        'Defaults to production/non-generated evidence. Use package_dependencies / package_cycles ' +
        'for exhaustive package evidence. Cursor continues package-edge pages.',
      inputSchema: strictInput({
        packages: packageArray(),
        filePath: exactFilePath().optional(),
        filePrefix: filePrefix().optional(),
        sourceScope: productionSourceScope(),
        generated: productionGeneratedPolicy(),
        ...pageFields(),
      }),
    },
    async (args) => {
      const outcome = await deps.graph.architectureSummary({
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        filter: {
          packages: args.packages,
          filePath: args.filePath,
          filePrefix: args.filePrefix,
          sourceScope: args.sourceScope,
          generated: args.generated,
        },
      });
      if (!outcome.ok) return errorResult(outcome.error);
      const targetConventions = deps.targetConventions ?? [];
      if (targetConventions.length === 0) return jsonResult(outcome.value);
      // Host/config projection only — does not change graph metric labels.
      return jsonResult({
        ...outcome.value,
        data: {
          ...outcome.value.data,
          targetConventions,
        },
      });
    },
  );
}
