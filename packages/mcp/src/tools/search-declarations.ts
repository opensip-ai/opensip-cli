/**
 * `search_declarations` — filter-first declaration-fact lookup (non-callable).
 *
 * Declaration IDs are inputs to `references_to` and must not be passed to
 * callable traversal tools (`who_calls`, `callees_of`, `blast_radius`, …).
 */

import { z } from 'zod';

import {
  compactDetail,
  exactFilePath,
  filePrefix,
  generatedPolicy,
  identitySearchLimit,
  packageArray,
  query as querySchema,
  searchMatch,
  sourceScope,
  strictInput,
  cursor,
  groupBy,
  MAX_ENUM_ARRAY,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const DECLARATION_KINDS = [
  'function',
  'class',
  'interface',
  'type-alias',
  'enum',
  'namespace',
  'variable',
  'property',
  'method',
  'import',
  'export',
] as const;

export function registerSearchDeclarations(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'search_declarations',
    {
      title: 'Search declarations',
      description:
        'Find compiler-attested declarations (interfaces, types, classes, functions, …) by name. ' +
        'Returns declaration IDs for references_to — NOT callable symbol IDs for who_calls/callees_of. ' +
        'match=substring (default), exact, or qualified. Default detail=nodes with limit=20. ' +
        'Pass detail=summary for counts, or detail=groups with groupBy=package|file. ' +
        'Exact TypeScript catalogs only; fast/old catalogs report unsupported inventory. ' +
        'Missing catalog returns empty data (run refresh_graph).',
      inputSchema: strictInput({
        query: querySchema(),
        match: searchMatch(),
        kinds: z
          .array(z.enum(DECLARATION_KINDS))
          .max(MAX_ENUM_ARRAY)
          .refine((items) => new Set(items).size === items.length, {
            message: 'kinds must be unique',
          })
          .optional(),
        packages: packageArray(),
        filePath: exactFilePath().optional(),
        filePrefix: filePrefix().optional(),
        sourceScope: sourceScope(),
        generated: generatedPolicy(),
        detail: compactDetail('nodes'),
        limit: identitySearchLimit(),
        cursor: cursor(),
        groupBy: groupBy(),
      }),
    },
    async (args) => {
      const outcome = await deps.graph.searchDeclarations(args.query, {
        match: args.match,
        kinds: args.kinds,
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        detail: args.detail ?? 'nodes',
        filter: {
          packages: args.packages,
          filePath: args.filePath,
          filePrefix: args.filePrefix,
          sourceScope: args.sourceScope,
          generated: args.generated,
        },
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
