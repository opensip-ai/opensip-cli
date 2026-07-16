import { packageSourceFilter, packageToolResult } from './package-tool-helpers.js';
import {
  packageEdgeKind,
  packageEvidenceLimit,
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
        'Return matching call/import evidence for a required package pair (fromPackage → toPackage). ' +
        'Default evidenceLimit=0 returns aggregate totalMatchingEvidence only (no concrete sites). ' +
        'Set evidenceLimit 1–100 to request bounded call/import sites. Use limit for paging those ' +
        'sites; evidenceLimit never substitutes for paging. Fast catalogs may omit import evidence ' +
        '(coverage partial).',
      inputSchema: strictInput({
        fromPackage: packageName(),
        toPackage: packageName(),
        edgeKind: packageEdgeKind(),
        evidenceLimit: packageEvidenceLimit(),
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
          evidenceLimit: args.evidenceLimit ?? 0,
        }),
      ),
  );
}
