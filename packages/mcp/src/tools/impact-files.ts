/** `impact_files` — bounded explicit-file changed-to-impact evidence. */

import { contextFiles, depth, strictInput, top } from './schemas.js';
import { errorResult, jsonResult } from './tool-result.js';

import type { McpStdioServer } from '../server.js';
import type { McpToolDeps } from './types.js';

export function registerImpactFiles(server: McpStdioServer, deps: McpToolDeps): void {
  server.register(
    'impact_files',
    {
      title: 'Estimate impact of explicit files',
      description:
        'Compute bounded changed-to-caller impact for explicit project-relative files. ' +
        'Inspect freshness, four-facet coverage, trust, unmatchedFiles, and nextActions before ' +
        'treating an empty impact set as authoritative.',
      inputSchema: strictInput({
        files: contextFiles(),
        depth: depth(),
        top: top(),
      }),
    },
    async ({ files, depth: maxDepth, top: topRows }, request) => {
      const outcome = await deps.graph.impactFiles(
        files,
        { maxDepth, ...(topRows === undefined ? {} : { top: topRows }) },
        request?.signal,
      );
      return outcome.ok ? jsonResult(outcome.value) : errorResult(outcome.error);
    },
  );
}
