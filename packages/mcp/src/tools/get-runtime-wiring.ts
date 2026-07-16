import { z } from 'zod';

import { boundedName, cursor, pageLimit, strictInput } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerGetRuntimeWiring(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_runtime_wiring',
    {
      title: 'Live tool runtime wiring',
      description:
        'Project live declarative tool wiring from the admitted tool registry, manifests, ' +
        'provenance, and the plain host+Tool command inventory captured when the MCP server ' +
        'started. This is NOT a source-level call graph — use trace_path from a separately ' +
        'resolved handler declaration for static calls. Edges are labelled by source ' +
        '(manifest/provenance/registry/command-spec/host-contract) with confidence and ' +
        'static-bridge status. Exclusive detail modes: summary (default), groups, or nodes.',
      inputSchema: strictInput({
        tool: boundedName('tool').optional(),
        command: boundedName('command').optional(),
        provenanceSource: z
          .enum(['bundled', 'installed', 'user-global', 'project-local'])
          .optional(),
        limit: pageLimit(),
        cursor: cursor(),
        groupBy: z.enum(['none', 'tool', 'source', 'owner']).default('none'),
        detail: z.enum(['summary', 'groups', 'nodes']).default('summary'),
      }),
    },
    async (args) => {
      const outcome = await deps.runtimeWiring.query({
        tool: args.tool,
        command: args.command,
        provenanceSource: args.provenanceSource,
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
        detail: args.detail,
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
