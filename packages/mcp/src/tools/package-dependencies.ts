import { z } from 'zod';

import {
  packageArray,
  packageEdgeKind,
  pageFields,
  productionGeneratedPolicy,
  productionSourceScope,
  packageName,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

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
      inputSchema: {
        edgeKind: packageEdgeKind(),
        package: packageName().optional(),
        direction: z.enum(['out', 'in', 'both']).default('out'),
        packages: packageArray(),
        sourceScope: productionSourceScope(),
        generated: productionGeneratedPolicy(),
        ...pageFields(),
      },
    },
    async (args) => {
      const outcome = await deps.graph.packageDependencies({
        edgeKind: args.edgeKind,
        package: args.package,
        direction: args.direction,
        filter: {
          packages: args.packages,
          sourceScope: args.sourceScope,
          generated: args.generated,
        },
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
