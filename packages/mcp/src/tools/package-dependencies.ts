import { z } from 'zod';

import { packageSourceFilter, packageToolResult } from './package-tool-helpers.js';
import {
  packageEdgeKind,
  packageSampleLimit,
  pageFields,
  packageName,
  sourceFilterFields,
  strictInput,
} from './schemas.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerPackageDependencies(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'package_dependencies',
    {
      title: 'Package dependency edges',
      description:
        'List package-level call and/or import dependency edges with labelled counts. ' +
        'Default edgeKind is call (production resolved call coupling). By default ' +
        'sampleLimit=0 returns count/distribution rows only (no nested evidence samples). ' +
        'Set sampleLimit 1–5 to request bounded concrete sites. Use limit for paging inventory ' +
        'rows; sampleLimit never changes row order or cursor continuation. Import edges may be ' +
        'partial on fast catalogs. Follow up with why_depends for a package pair and ' +
        'package_cycles for SCCs.',
      inputSchema: strictInput({
        edgeKind: packageEdgeKind(),
        package: packageName().optional(),
        direction: z.enum(['out', 'in', 'both']).default('out'),
        sampleLimit: packageSampleLimit(),
        ...sourceFilterFields('production'),
        ...pageFields(),
      }),
    },
    async (args) =>
      packageToolResult(
        deps.graph.packageDependencies({
          edgeKind: args.edgeKind,
          package: args.package,
          direction: args.direction,
          filter: packageSourceFilter(args),
          limit: args.limit,
          cursor: args.cursor,
          groupBy: args.groupBy,
          sampleLimit: args.sampleLimit ?? 0,
        }),
      ),
  );
}
