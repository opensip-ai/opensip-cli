import { z } from 'zod';

import { packageSourceFilter, packageToolResult } from './package-tool-helpers.js';
import {
  packageEdgeKind,
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
        'List package-level call and/or import dependency edges with labelled evidence. ' +
        'Default edgeKind is call (production resolved call coupling). Import edges come from ' +
        'module-init dependencies and may be partial on fast catalogs. Use why_depends for a ' +
        'specific package pair and package_cycles for SCCs.',
      inputSchema: strictInput({
        edgeKind: packageEdgeKind(),
        package: packageName().optional(),
        direction: z.enum(['out', 'in', 'both']).default('out'),
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
        }),
      ),
  );
}
