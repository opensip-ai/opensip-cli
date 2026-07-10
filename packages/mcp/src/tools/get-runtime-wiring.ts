import { z } from 'zod';

import { cursor, pageLimit } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

const name256 = () =>
  z
    .string()
    .min(1)
    .max(256)
    .refine(
      (v) => {
        for (let i = 0; i < v.length; i++) {
          const c = v.codePointAt(i) ?? 0;
          if (c <= 0x1f || c === 0x7f) return false;
        }
        return true;
      },
      { message: 'must not contain control characters' },
    );

export function registerGetRuntimeWiring(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'get_runtime_wiring',
    {
      title: 'Live tool runtime wiring',
      description:
        'Project live declarative tool wiring from the admitted tool registry, manifests, ' +
        'provenance, and CommandSpecs captured when the MCP server started. This is NOT a ' +
        'source-level call graph — use trace_path from a separately resolved handler symbol for ' +
        'static calls. Edges are labelled by source (manifest/provenance/registry/command-spec/' +
        'host-contract) with confidence and unresolved static bridges.',
      inputSchema: {
        tool: name256().optional(),
        command: name256().optional(),
        provenanceSource: name256().optional(),
        limit: pageLimit(),
        cursor: cursor(),
        groupBy: z.enum(['none', 'package', 'file', 'tool', 'source']).default('none'),
      },
    },
    async (args) => {
      if (deps.runtimeWiring === undefined) {
        return errorResult({
          code: 'runtime-wiring-unavailable',
          message: 'Runtime wiring port is not configured for this server.',
        });
      }
      const outcome = await deps.runtimeWiring.query({
        tool: args.tool,
        command: args.command,
        provenanceSource: args.provenanceSource,
        limit: args.limit,
        cursor: args.cursor,
        groupBy: args.groupBy,
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
