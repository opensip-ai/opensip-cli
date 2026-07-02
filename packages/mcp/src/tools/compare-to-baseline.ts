/**
 * `compare_to_baseline` — persisted session vs. stored gate baseline.
 *
 * Reads `resultsPort.compareToBaseline()` only. The comparison is based on
 * persisted signal fingerprints and generic baseline rows, never a fresh run.
 */

import { z } from 'zod';

import {
  limit as limitSchema,
  sessionRef as sessionRefSchema,
  toolId as toolIdSchema,
} from './schemas.js';
import { errorResult, jsonResult, unknownToolError } from './tool-result.js';

import type { McpToolDeps } from './types.js';
import type { McpStdioServer } from '../server.js';

export function registerCompareToBaseline(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'compare_to_baseline',
    {
      title: 'Compare an OpenSIP run to its baseline',
      description:
        'Use this OpenSIP MCP result tool to compare a stored fit/graph/yagni/sim run ' +
        'against that tool’s saved baseline. It replays the persisted session, reads ' +
        'stored baseline fingerprints, returns added/unchanged/resolved counts, and ' +
        'never re-runs the underlying tool.',
      inputSchema: {
        tool: toolIdSchema(),
        ref: sessionRefSchema().optional(),
        limit: limitSchema(),
        includeResolved: z.boolean().optional(),
      },
    },
    async ({ tool, ref, limit, includeResolved }) => {
      if (!deps.validToolIds.has(tool)) return unknownToolError(tool, deps.validToolIds);
      const outcome = await deps.results.compareToBaseline({
        tool,
        ...(ref === undefined ? {} : { ref }),
        ...(limit === undefined ? {} : { limit }),
        ...(includeResolved === undefined ? {} : { includeResolved }),
      });
      if (!outcome.ok) return errorResult(outcome.error);
      return jsonResult(outcome.value);
    },
  );
}
