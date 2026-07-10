import {
  packageEdgeKind,
  pageFields,
  productionGeneratedPolicy,
  productionSourceScope,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerPackageCycles(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'package_cycles',
    {
      title: 'Package dependency cycles',
      description:
        'Find non-trivial package strongly-connected components (cycles) for call, import, or ' +
        'combined edges. Returns member packages and up to 50 proving edges per component with ' +
        'total proof counts and coverage when more exist.',
      inputSchema: {
        edgeKind: packageEdgeKind(),
        sourceScope: productionSourceScope(),
        generated: productionGeneratedPolicy(),
        ...pageFields(),
      },
    },
    async (args) => {
      const outcome = await deps.graph.packageCycles({
        edgeKind: args.edgeKind,
        filter: {
          sourceScope: args.sourceScope,
          generated: args.generated,
        },
        limit: args.limit,
        cursor: args.cursor,
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
