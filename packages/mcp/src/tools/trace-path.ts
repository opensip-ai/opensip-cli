/**
 * `trace_path` — shortest forward call path `from → … → to`.
 *
 * Routes through one `GraphReadPort.traverse` call so path, context, and
 * freshness share a single immutable generation.
 */

import {
  depth as depthSchema,
  pageFields,
  sourceFilterFields,
  strictInput,
  symbolId as symbolIdSchema,
  traversalIdentity,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerTracePath(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'trace_path',
    {
      title: 'Trace a call path',
      description:
        'Find a forward call path from one symbol to another within `depth` (default 5, max 5). ' +
        'Default identity is occurrence-precise; identity=body-twin-union labels that any twin ' +
        'in a group may supply a hop. Distinguishes complete no-path from cap-truncated search ' +
        'via coverage.truncated. Returns ordered path plus hop evidence when available.',
      inputSchema: strictInput({
        fromSymbolId: symbolIdSchema(),
        toSymbolId: symbolIdSchema(),
        depth: depthSchema(),
        identity: traversalIdentity(),
        ...sourceFilterFields(),
        ...pageFields(),
      }),
    },
    async (args) => {
      const outcome = await deps.graph.traverse({
        direction: 'path',
        startSymbolId: args.fromSymbolId,
        goalSymbolId: args.toSymbolId,
        depth: args.depth,
        identity: args.identity,
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
