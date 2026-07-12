import { type z } from 'zod';

import { packageSourceFilter, packageToolResult } from './package-tool-helpers.js';
import {
  packageEdgeKind,
  packageProofLimit,
  pageFields,
  sourceFilterFields,
  strictInput,
} from './schemas.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const packageCyclesInput = strictInput({
  edgeKind: packageEdgeKind(),
  proofLimit: packageProofLimit(),
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
      proofLimit: args.proofLimit ?? 0,
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
        'component has at least two distinct packages. Default proofLimit=0 returns package ' +
        'members and totalProofEdges counts only (no proving edges). Set proofLimit 1–50 to ' +
        'request bounded proof edges. Use limit for paging components; proofLimit never changes ' +
        'component membership or cursor order.',
      inputSchema: packageCyclesInput,
    },
    (args) => queryPackageCycles(deps, args),
  );
}
