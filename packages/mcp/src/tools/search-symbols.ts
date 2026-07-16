/**
 * `search_symbols` — filter-first name/exact/qualified symbol lookup.
 */

import {
  compactDetail,
  exactFilePath,
  filePrefix,
  generatedPolicy,
  identitySearchLimit,
  kinds,
  packageArray,
  query as querySchema,
  searchMatch,
  sourceScope,
  strictInput,
  cursor,
  groupBy,
  visibilities,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerSearchSymbols(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'search_symbols',
    {
      title: 'Search symbols',
      description:
        'Find functions/methods by name. match=substring (default, case-insensitive simpleName), ' +
        'exact (case-sensitive simpleName), or qualified (case-sensitive qualifiedName). ' +
        'Default detail=nodes with limit=20 returns symbol IDs for traversal tools. ' +
        'Pass detail=summary for match counts only, or detail=groups with groupBy=package|file. ' +
        'Filters apply BEFORE the page limit. Use page.nextCursor for continuation; a missing ' +
        'catalog returns empty data (run refresh_graph).',
      inputSchema: strictInput({
        query: querySchema(),
        match: searchMatch(),
        packages: packageArray(),
        filePath: exactFilePath().optional(),
        filePrefix: filePrefix().optional(),
        kinds: kinds(),
        visibilities: visibilities(),
        sourceScope: sourceScope(),
        generated: generatedPolicy(),
        detail: compactDetail('nodes'),
        limit: identitySearchLimit(),
        cursor: cursor(),
        groupBy: groupBy(),
      }),
    },
    async (args) => {
      const outcome = await deps.graph.searchSymbols(args.query, {
        match: args.match,
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        detail: args.detail ?? 'nodes',
        filter: {
          packages: args.packages,
          filePath: args.filePath,
          filePrefix: args.filePrefix,
          kinds: args.kinds,
          visibilities: args.visibilities,
          sourceScope: args.sourceScope,
          generated: args.generated,
        },
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
