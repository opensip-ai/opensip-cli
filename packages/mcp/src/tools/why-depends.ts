import { packageSourceFilter, packageToolResult } from './package-tool-helpers.js';
import {
  packageEdgeKind,
  packageName,
  pageFields,
  sourceFilterFields,
  strictInput,
} from './schemas.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerWhyDepends(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'why_depends',
    {
      title: 'Why package A depends on package B',
      description:
        'Return bounded call/import evidence for a required package pair (fromPackage → toPackage). ' +
        'Call edges include symbol refs, call sites, resolution, and confidence. Import edges retain ' +
        'specifiers. Fast catalogs may omit import evidence (coverage partial).',
      inputSchema: strictInput({
        fromPackage: packageName(),
        toPackage: packageName(),
        edgeKind: packageEdgeKind(),
        ...sourceFilterFields('production'),
        ...pageFields(),
      }),
    },
    async (args) =>
      packageToolResult(
        deps.graph.whyDepends({
          fromPackage: args.fromPackage,
          toPackage: args.toPackage,
          edgeKind: args.edgeKind,
          filter: packageSourceFilter(args),
          limit: args.limit,
          cursor: args.cursor,
          groupBy: args.groupBy,
        }),
      ),
  );
}
