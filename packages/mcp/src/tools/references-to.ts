/**
 * `references_to` — cross-file references to a declaration id.
 *
 * Exact TypeScript only; referenceScope is always 'cross-file' (same-file and
 * declaration-file sites are intentionally omitted).
 */

import { z } from 'zod';

import {
  boundedText,
  compactDetail,
  exactFilePath,
  filePrefix,
  generatedPolicy,
  packageArray,
  pageLimit,
  sourceScope,
  strictInput,
  cursor,
  groupBy,
  MAX_ENUM_ARRAY,
  MAX_PATH_LEN,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const REFERENCE_KINDS = [
  'type',
  'value',
  'import',
  'export',
  'heritage',
  'annotation',
] as const;

/** Declaration ids are stable `d1|…` keys, not file:line:col symbol ids. */
const declarationId = () =>
  boundedText(MAX_PATH_LEN + 128, 'declarationId').refine(
    (value) => value.startsWith('d1|') || value.startsWith('d1'),
    {
      message: 'declarationId must be a search_declarations id (d1|…), not a symbolId',
    },
  );

export function registerReferencesTo(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'references_to',
    {
      title: 'References to declaration',
      description:
        'List cross-file compiler-labelled references to a declaration id from search_declarations. ' +
        'referenceScope is always cross-file: same-file uses and .d.ts reference sites are omitted. ' +
        'Exact TypeScript catalogs only; fast/old catalogs report unsupported inventory. ' +
        'Default detail=summary returns counts/distributions without sites; ' +
        'detail=nodes returns sites; detail=groups requires groupBy=package|file. ' +
        'Callable traversal tools reject these declaration ids.',
      inputSchema: strictInput({
        declarationId: declarationId(),
        kinds: z
          .array(z.enum(REFERENCE_KINDS))
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
        detail: compactDetail('summary'),
        limit: pageLimit(),
        cursor: cursor(),
        groupBy: groupBy(),
      }),
    },
    async (args) => {
      const outcome = await deps.graph.referencesTo(args.declarationId, {
        kinds: args.kinds,
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        detail: args.detail ?? 'summary',
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
