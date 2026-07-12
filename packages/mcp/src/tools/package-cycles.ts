import { type z } from 'zod';

import { packageSourceFilter, packageToolResult } from './package-tool-helpers.js';
import { packageEdgeKind, pageFields, sourceFilterFields, strictInput } from './schemas.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const packageCyclesInput = strictInput({
  edgeKind: packageEdgeKind(),
  ...sourceFilterFields('production'),
  ...pageFields(),
});

async function queryPackageCycles(deps: McpToolDeps, args: z.infer<typeof packageCyclesInput>) {
  return packageToolResult(
    deps.graph.packageCycles({
      edgeKind: args.edgeKind,
      filter: packageSourceFilter(args),
      limit: args.limit,
      cursor: args.cursor,
      groupBy: args.groupBy,
    }),
  );
}

export function registerPackageCycles(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'package_cycles',
    {
      title: 'Package dependency cycles',
      description:
        'Find non-trivial package strongly-connected components (cycles) for call, import, or ' +
        'combined edges. Intra-package (self) aggregate edges are excluded, so every returned ' +
        'component has at least two distinct packages. Returns member packages and up to 50 ' +
        'proving edges per component with total proof counts and coverage when more exist.',
      inputSchema: packageCyclesInput,
    },
    (args) => queryPackageCycles(deps, args),
  );
}
