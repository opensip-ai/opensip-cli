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
        'sites; evidenceLimit never substitutes for paging. A groupBy request implies evidence: ' +
        'with groupBy set, an omitted evidenceLimit uses the bounded library default and an ' +
        'explicit one is floored at 1. Fast catalogs may omit import evidence (coverage partial).',
      inputSchema: strictInput({
        fromPackage: packageName(),
        toPackage: packageName(),
        edgeKind: packageEdgeKind('combined'),
        evidenceLimit: packageEvidenceLimit(),
        ...sourceFilterFields('production'),
        ...pageFields(),
      }),
    },
    async (args) => {
      // Grouping operates over the concrete evidence arrays. At the documented
      // aggregates-only default (evidenceLimit 0) those arrays are empty, so a
      // groupBy request would silently group zero rows and report itself
      // complete. Requesting groupBy is an implicit request for the evidence
      // universe: omit the limit so the library's bounded default applies, and
      // floor an explicit limit at 1 (mirrors package_dependencies' sampleLimit
      // handling for file grouping).
      const groupBy = args.groupBy ?? 'none';
      const evidenceLimit =
        groupBy === 'none'
          ? (args.evidenceLimit ?? 0)
          : args.evidenceLimit === undefined
            ? undefined
            : Math.max(args.evidenceLimit, 1);
      return packageToolResult(
        deps.graph.whyDepends({
          fromPackage: args.fromPackage,
          toPackage: args.toPackage,
          edgeKind: args.edgeKind,
          filter: packageSourceFilter(args),
          limit: args.limit,
          cursor: args.cursor,
          groupBy: args.groupBy,
          ...(evidenceLimit === undefined ? {} : { evidenceLimit }),
        }),
      );
    },
  );
}
