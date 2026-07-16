/**
 * Shared registration for bounded call-graph walk tools.
 *
 * `who_calls` and `callees_of` route through one `GraphReadPort.traverse` call
 * so a single immutable generation is captured for the whole walk.
 */

import {
  compactDetail,
  depth as depthSchema,
  pageFields,
  sourceFilterFields,
  strictInput,
  symbolId as symbolIdSchema,
  traversalIdentity,
} from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { GraphReadPort } from '../graph-read-port.js';
import type { McpStdioServer } from '../server.js';

export interface CallWalkToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly direction: 'callers' | 'callees';
}

export function registerCallWalkTool(
  server: McpStdioServer,
  graphPort: GraphReadPort,
  spec: CallWalkToolSpec,
): void {
  server.register(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: strictInput({
        symbolId: symbolIdSchema(),
        depth: depthSchema(),
        identity: traversalIdentity(),
        detail: compactDetail('nodes'),
        ...sourceFilterFields(),
        ...pageFields(),
      }),
    },
    async (args) => {
      const outcome = await graphPort.traverse({
        direction: spec.direction,
        startSymbolId: args.symbolId,
        depth: args.depth,
        identity: args.identity,
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
