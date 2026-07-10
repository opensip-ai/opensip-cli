import {
  packageEdgeKind,
  pageLimit,
  cursor,
  packageName,
  productionGeneratedPolicy,
  productionSourceScope,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

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
      inputSchema: {
        fromPackage: packageName(),
        toPackage: packageName(),
        edgeKind: packageEdgeKind(),
        sourceScope: productionSourceScope(),
        generated: productionGeneratedPolicy(),
        limit: pageLimit(),
        cursor: cursor(),
      },
    },
    async (args) => {
      const outcome = await deps.graph.whyDepends({
        fromPackage: args.fromPackage,
        toPackage: args.toPackage,
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
