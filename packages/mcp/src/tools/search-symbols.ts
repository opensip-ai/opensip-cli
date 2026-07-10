/**
 * `search_symbols` — filter-first name/exact/qualified symbol lookup.
 */

import {
  exactFilePath,
  filePrefix,
  generatedPolicy,
  kinds,
  packageArray,
  pageFields,
  query as querySchema,
  searchMatch,
  sourceScope,
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
        'Filters (package/filePath/filePrefix/kinds/visibilities/sourceScope/generated) apply ' +
        'BEFORE the page limit. Returns symbolId ("<filePath>:<line>:<column>") + bodyHash — pass ' +
        'that symbolId to who_calls, callees_of, blast_radius, or trace_path. Use cursor from ' +
        'page.nextCursor for continuation; a missing catalog returns empty data (run refresh_graph).',
      inputSchema: {
        query: querySchema(),
        match: searchMatch(),
        packages: packageArray(),
        filePath: exactFilePath().optional(),
        filePrefix: filePrefix().optional(),
        kinds: kinds(),
        visibilities: visibilities(),
        sourceScope: sourceScope(),
        generated: generatedPolicy(),
        ...pageFields(),
      },
    },
    async (args) => {
      const outcome = await deps.graph.searchSymbols(args.query, {
        match: args.match,
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
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
